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

/* ------------------------------------------------------------------------ */
/* Toolbar ownership                                                         */
/* ------------------------------------------------------------------------ */
//
// One toolbar, one owner at a time. The owner is DERIVED here rather than
// inferred from focus, so a blur — clicking a toolbar button is a blur — can
// never change which editor a command reaches.

export const TOOLBAR_OWNER = {
  NONE: "none",
  FREEFORM: "freeform",
  TEMPLATE_ROW: "template-row",
};

/**
 * Which editor the shared formatting toolbar acts on right now.
 *
 * Free-form view  -> the Free-form editor (unchanged behaviour).
 * Template form   -> the ONE active Template Text-row editor, and only while
 *                    such a row is active. No active Text answer, a structured
 *                    field, or a focused row label all mean "nobody owns it",
 *                    and every control is then genuinely disabled — the
 *                    Free-form editor is merely hidden behind this view and
 *                    must never be dispatched into.
 */
export function resolveToolbarOwner({
  hasNote,
  noteLayout,
  hasFreeformEditor,
  hasTemplateRowEditor,
} = {}) {
  if (!hasNote) return TOOLBAR_OWNER.NONE;
  if (noteLayout === TEMPLATE_LAYOUT) {
    return hasTemplateRowEditor ? TOOLBAR_OWNER.TEMPLATE_ROW : TOOLBAR_OWNER.NONE;
  }
  if (noteLayout !== FREEFORM_LAYOUT) return TOOLBAR_OWNER.NONE;
  return hasFreeformEditor ? TOOLBAR_OWNER.FREEFORM : TOOLBAR_OWNER.NONE;
}

/**
 * The controls a Template Text answer supports.
 *
 * A Template Text answer is a form field, not a document: it carries emphasis,
 * lists, alignment, approved colours and approved links, and nothing that would
 * embed media, restructure the page or act on a whole document. Every control
 * outside this set stays present but genuinely disabled while the toolbar
 * belongs to a Template row, so the toolbar's shape never shifts.
 *
 * `null` means "every control" and is what the Free-form editor uses — its
 * toolbar is unchanged by this feature.
 */
export const TEMPLATE_TEXT_CONTROLS = new Set([
  "undo",
  "redo",
  "clearFormatting",
  "bold",
  "italic",
  "underline",
  "strike",
  "bulletList",
  "orderedList",
  // List nesting only. There is deliberately no arbitrary paragraph indent:
  // these commands act on a list item or are disabled.
  "indent",
  "outdent",
  "alignLeft",
  "alignCenter",
  "alignRight",
  "alignJustify",
  "link",
  "unlink",
  "textColor",
  "highlightColor",
  "highlight",
]);

/** Shown when the Template form is visible but no Text answer is active. */
export const TEMPLATE_TOOLBAR_HINT = "Select a Text answer to use formatting.";

/** True when `controls` (null = unrestricted) permits this control. */
export function isToolbarControlAllowed(controls, key) {
  if (!controls) return true;
  return controls.has(key);
}

/* ------------------------------------------------------------------------ */
/* Template-row ownership transitions                                        */
/* ------------------------------------------------------------------------ */

// What the user just put focus into inside the Template document.
export const TEMPLATE_FOCUS = {
  ANSWER: "answer", // the right-hand answer control of a row
  STRUCTURED: "structured", // number/date/time/checkbox/yes-no/dropdown/photo/file
  LABEL: "label", // a note-specific row's own label (always plain text)
};

/**
 * The Text row that owns the toolbar after a focus event, or null.
 *
 * A structured control and a row label both CLEAR ownership: a label is plain
 * text by definition, and formatting must never be applied to the answer of a
 * row whose label the caret is sitting in.
 */
export function nextActiveTextRow({ target, rowId, isTextRow } = {}) {
  if (target !== TEMPLATE_FOCUS.ANSWER) return null;
  if (!rowId || !isTextRow) return null;
  return rowId;
}

/**
 * May an editor change be committed?
 *
 * Both arguments are the SAME kind of token — a full editor identity (see
 * `templateRowEditorIdentity`). The active identity is passed explicitly so a
 * late callback from an editor that has already been replaced cannot write
 * into whatever replaced it, whether that is another row, another version of
 * the same row, or the same row under a different template.
 */
export function canCommitRowEdit(activeIdentity, identity) {
  return !!identity && !!activeIdentity && activeIdentity === identity;
}

/* ------------------------------------------------------------------------ */
/* Template row editor identity                                              */
/* ------------------------------------------------------------------------ */

/**
 * The complete identity of one Template Text editor.
 *
 * A row id alone is NOT an identity: the same field id exists in every
 * immutable version published from a template, and two templates may contain
 * the same id entirely. Editing "Site conditions" on version 3 is a different
 * editor — different answer, different history — from editing "Site conditions"
 * on version 2, even though the row id is identical.
 *
 * The parts are the note instance's own fields (`noteId`, `templateId`,
 * `templateVersionId`) plus the row and whether it is a note-specific custom
 * row (a custom row's answer lives on the row, a master row's in `answers`, so
 * an id shared between the two would otherwise be ambiguous).
 *
 * Returns a comparable token, or null when there is no addressable editor.
 */
export function templateRowEditorIdentity({
  noteId,
  templateId = null,
  templateVersionId = null,
  rowId,
  isCustomRow = false,
} = {}) {
  if (!noteId || !rowId) return null;
  return JSON.stringify([
    noteId,
    templateId ?? null,
    templateVersionId ?? null,
    rowId,
    !!isCustomRow,
  ]);
}

/**
 * The identity of the currently active row, or null.
 *
 * `rowExists` is the caller's answer to "is this row still part of what the
 * note is pinned to right now" — a master row of the pinned version, or one of
 * this note's custom rows for the assigned template. Re-pinning a note to
 * another template or version can remove the row the user was editing; when it
 * does, there is no active editor, no toolbar owner, and the toolbar says so.
 */
export function resolveActiveRowIdentity({ rowExists, ...parts } = {}) {
  if (!rowExists) return null;
  return templateRowEditorIdentity(parts);
}

/**
 * The single rule for who owns the one Template editor registration.
 *
 * `current` is `{ identity, editor }` or null.
 *
 * Registering an editor always takes ownership. **Unregistering only succeeds
 * for the identity that currently holds it** — so a cleanup belonging to a
 * replaced editor can never remove the registration of the editor that
 * replaced it, whatever order the two callbacks arrive in. A refused call
 * returns the same reference, so a caller can detect a no-op.
 */
export function applyRowEditorRegistration(current, { identity, editor } = {}) {
  if (editor) {
    if (!identity) return current || null;
    if (current && current.identity === identity && current.editor === editor) {
      return current;
    }
    return { identity, editor };
  }
  if (!current) return current || null;
  if (!identity || current.identity !== identity) return current; // stale: refused
  return null;
}
