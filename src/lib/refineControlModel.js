// src/lib/refineControlModel.js
//
// THE PURE MODEL BEHIND THE HEADER REFINE CONTROL: which surface Refine acts
// on, which SCOPES that surface offers right now, which one is the default,
// and what the control should say before a request is spent.
//
// The control's one job is to make WHAT WILL CHANGE unmistakable before the
// user presses Refine — never to surprise someone by rewriting a whole
// document when they meant one paragraph. So every scope carries an
// availability and, when unavailable, the reason, and the summary line names
// the target in plain words.
//
// Pure: no React, no editor, no DOM. The component feeds it three facts it
// reads from the owning editor (`hasSelection`, `documentHasBoundary`) and the
// toolbar owner, and renders what comes back.

import { REFINE_SCOPE, REFINE_SCOPE_LABEL } from "./editorRangeRefine";
import { TOOLBAR_OWNER } from "./editorToolbarState";

/** Which document surface the header Refine acts on. */
export const REFINE_SURFACE = Object.freeze({
  FREEFORM: "freeform",
  TEMPLATE_SECTION: "template-section",
  NONE: "none",
});

/** The surface for a toolbar owner: Refine follows the SAME owner as formatting. */
export function refineSurfaceForOwner(owner) {
  if (owner === TOOLBAR_OWNER.FREEFORM) return REFINE_SURFACE.FREEFORM;
  if (owner === TOOLBAR_OWNER.TEMPLATE_SECTION) return REFINE_SURFACE.TEMPLATE_SECTION;
  return REFINE_SURFACE.NONE;
}

export const REFINE_SCOPE_UNAVAILABLE = Object.freeze({
  [REFINE_SCOPE.SELECTION]: "Select some text first",
  [REFINE_SCOPE.DOCUMENT]:
    "This note contains an image, file, table or code block — select the text to refine instead",
});

/**
 * The scopes one surface offers, in display order, each with `available` and
 * (when not) the reason.
 *
 *   Free-form          Selected text · Entire note
 *   Template Section   Selected text · Text at cursor
 *
 * TWO conceptual scopes per surface, deliberately. A "current paragraph"
 * option existed briefly (2026-08-18) and was removed the same day after
 * review: selecting the paragraph does the same thing, so it was a third
 * choice in every popover for no extra capability.
 */
export function refineScopeOptions({
  surface,
  hasSelection = false,
  documentHasBoundary = false,
} = {}) {
  const selection = {
    scope: REFINE_SCOPE.SELECTION,
    label: REFINE_SCOPE_LABEL[REFINE_SCOPE.SELECTION],
    available: !!hasSelection,
    reason: hasSelection ? null : REFINE_SCOPE_UNAVAILABLE[REFINE_SCOPE.SELECTION],
  };
  if (surface === REFINE_SURFACE.FREEFORM) {
    return [
      selection,
      {
        scope: REFINE_SCOPE.DOCUMENT,
        label: REFINE_SCOPE_LABEL[REFINE_SCOPE.DOCUMENT],
        available: !documentHasBoundary,
        reason: documentHasBoundary ? REFINE_SCOPE_UNAVAILABLE[REFINE_SCOPE.DOCUMENT] : null,
      },
    ];
  }
  if (surface === REFINE_SURFACE.TEMPLATE_SECTION) {
    return [
      selection,
      {
        scope: REFINE_SCOPE.RUN,
        label: REFINE_SCOPE_LABEL[REFINE_SCOPE.RUN],
        available: true,
        reason: null,
      },
    ];
  }
  return [];
}

/**
 * The scope the control proposes when the user has not chosen one:
 * a selection when there is one (the user pointed at something), otherwise
 * the surface's whole-target — the entire note, or the Section text at the
 * cursor. Null when nothing is available.
 */
export function defaultRefineScope(options) {
  if (!Array.isArray(options) || !options.length) return null;
  const selection = options.find((o) => o.scope === REFINE_SCOPE.SELECTION);
  if (selection && selection.available) return selection.scope;
  const whole = options.find(
    (o) => (o.scope === REFINE_SCOPE.DOCUMENT || o.scope === REFINE_SCOPE.RUN) && o.available
  );
  if (whole) return whole.scope;
  const any = options.find((o) => o.available);
  return any ? any.scope : null;
}

/**
 * The scope actually in effect: the user's explicit choice while it is still
 * available, else the default. An explicit "Selected text" that lost its
 * selection therefore falls back rather than running against nothing.
 */
export function resolveRefineScope(choice, options) {
  if (choice && Array.isArray(options)) {
    const match = options.find((o) => o.scope === choice);
    if (match && match.available) return choice;
  }
  return defaultRefineScope(options);
}

/** What the trigger's tooltip says when Refine cannot run. Null when it can. */
export function refineTriggerDisabledReason({ surface, hasNote = true, loading = false } = {}) {
  if (!hasNote) return "Open a note to use AI Refine";
  if (loading) return null;
  if (surface === REFINE_SURFACE.NONE) return "Select a section to refine";
  return null;
}

/** The one line the popover shows above its Refine button. */
export function refineScopeSummary(scope, surface) {
  if (!scope) return "Nothing to refine here yet";
  const label = REFINE_SCOPE_LABEL[scope] || scope;
  if (surface === REFINE_SURFACE.TEMPLATE_SECTION && scope === REFINE_SCOPE.RUN) {
    return "Will change: the paragraphs at the cursor in this section";
  }
  return `Will change: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}
