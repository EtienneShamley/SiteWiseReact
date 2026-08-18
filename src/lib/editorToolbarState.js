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
  /**
   * The active flexible Template SECTION's shared editor
   * (src/components/template/TemplateSectionEditor.js over the retained
   * registry). Named `template-row` until Phase G, when the per-row/per-TextItem
   * roving editor it used to mean was retired; the VALUE is unchanged so no
   * stored or serialized state depends on the rename.
   */
  TEMPLATE_SECTION: "template-row",
};

/**
 * Which editor the shared formatting toolbar acts on right now.
 *
 * Free-form view  -> the Free-form editor (unchanged behaviour).
 * Template form   -> the ONE active Template SECTION editor, and only while a
 *                    Section is active. No active Section, a structured field,
 *                    or a focused row label all mean "nobody owns it", and
 *                    every control is then genuinely disabled — the Free-form
 *                    editor is merely hidden behind this view and must never be
 *                    dispatched into.
 *
 * There is ONE toolbar, ONE owner and ONE command path: the owner is DERIVED
 * here, the surface's editor instance is handed to the toolbar, and every
 * command and every active-state read goes through that one instance. No
 * surface has its own toolbar implementation.
 */
export function resolveToolbarOwner({
  hasNote,
  noteLayout,
  hasFreeformEditor,
  hasTemplateSectionEditor,
} = {}) {
  if (!hasNote) return TOOLBAR_OWNER.NONE;
  if (noteLayout === TEMPLATE_LAYOUT) {
    return hasTemplateSectionEditor ? TOOLBAR_OWNER.TEMPLATE_SECTION : TOOLBAR_OWNER.NONE;
  }
  if (noteLayout !== FREEFORM_LAYOUT) return TOOLBAR_OWNER.NONE;
  return hasFreeformEditor ? TOOLBAR_OWNER.FREEFORM : TOOLBAR_OWNER.NONE;
}

/*
 * WHICH CONTROLS THE OWNER SUPPORTS is no longer a per-surface list kept here.
 *
 * Until 2026-08-18 this module exported `SECTION_TOOLBAR_CONTROLS`, a
 * hand-maintained allowlist of what a Template Section could do. It drifted
 * once (Phase G made a Section one real document while the list still
 * described the retired Text answer field), and it would have drifted again
 * with every capability added. The permitted set is now DERIVED from the owning
 * editor's own schema and commands — src/lib/editorCapabilities.js
 * (`toolbarControlsForEditor`) — inside the toolbar itself. Both surfaces are
 * built from the shared editor core, so the derived sets are identical today;
 * a genuine future difference would follow the editor automatically.
 */

/** Shown when the Template form is visible but no Section is active. */
export const TEMPLATE_TOOLBAR_HINT = "Select a section to use formatting.";

/** True when `controls` (null = unrestricted) permits this control. */
export function isToolbarControlAllowed(controls, key) {
  if (!controls) return true;
  return controls.has(key);
}

/* ------------------------------------------------------------------------ */
/* Template Section editor registration                                      */
/* ------------------------------------------------------------------------ */
//
// PHASE G. This section once also carried the LEGACY Template row-editor
// identity model — `TEMPLATE_FOCUS`, `nextActiveTextRow`, `canCommitRowEdit`,
// `templateRowEditorIdentity` and `resolveActiveRowIdentity` — which addressed
// the per-row / per-TextItem roving editor of a Template Section. That editor
// was retired: a flexible Section is ONE shared editor, identified by
// `sectionEditorIdentity` (src/lib/sectionEditorRegistry.js), and those
// functions were deleted with it. What remains is the ONE rule the Section
// editor still needs from here — who owns the single Template editor
// registration the shared toolbar targets.

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
