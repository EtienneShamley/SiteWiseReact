// src/lib/noteSurfaces.js
//
// The SURFACES of the open note as one navigation system — what the left
// sidebar's "This note" group lists and what MainArea renders:
//
//   Template form   the structured company-template view of this note
//   Free-form note  the unrestricted rich-text view of this note
//   PDF             the note-linked PDF (annotation editor)
//
// Two pieces of transient application state already decide which surface is
// on screen, and both stay exactly what they are:
//   - `activeNoteView`   ("natural" | "template")  which NOTE VIEW is being
//                        edited — also what an export uses as its SOURCE, so
//                        the PDF surface deliberately does not touch it;
//   - `noteWorkspaceTab` ("note" | "pdf")           whether the note view or
//                        the linked PDF is showing.
// This module is the one place that maps between a surface and that pair, so
// the sidebar, the rail and MainArea can never disagree about which surface is
// current or what selecting one does. Pure: no React, no storage, no DOM.
import { NOTE_VIEW, NOTE_VIEW_LABEL } from "./noteViews";

export const NOTE_SURFACE = Object.freeze({
  TEMPLATE_FORM: "template-form",
  FREEFORM: "freeform",
  PDF: "pdf",
});

// Sidebar order: the two note views first, the linked PDF last.
export const NOTE_SURFACE_ORDER = Object.freeze([
  NOTE_SURFACE.TEMPLATE_FORM,
  NOTE_SURFACE.FREEFORM,
  NOTE_SURFACE.PDF,
]);

// The stored note-view identifiers MainArea already uses (unchanged).
export const NOTE_LAYOUT = Object.freeze({ NATURAL: "natural", TEMPLATE: "template" });
export const NOTE_WORKSPACE_TAB = Object.freeze({ NOTE: "note", PDF: "pdf" });

// User-facing names — the two note views reuse the ONE definition every other
// surface reads (noteViews.js), so the sidebar cannot drift from the status
// line, the export control or the accessible names.
export const NOTE_SURFACE_LABEL = Object.freeze({
  [NOTE_SURFACE.TEMPLATE_FORM]: NOTE_VIEW_LABEL[NOTE_VIEW.TEMPLATE_FORM],
  [NOTE_SURFACE.FREEFORM]: NOTE_VIEW_LABEL[NOTE_VIEW.FREEFORM],
  [NOTE_SURFACE.PDF]: "PDF",
});

// One-line purpose per surface — the tooltip / description text.
export const NOTE_SURFACE_HINT = Object.freeze({
  [NOTE_SURFACE.TEMPLATE_FORM]:
    "Complete the structured template form assigned to this note",
  [NOTE_SURFACE.FREEFORM]: "Write an unrestricted rich-text note",
  [NOTE_SURFACE.PDF]: "View and annotate the PDF linked to this note",
});

export function isNoteSurface(value) {
  return NOTE_SURFACE_ORDER.indexOf(value) !== -1;
}

export function noteSurfaceLabel(surface) {
  return NOTE_SURFACE_LABEL[surface] || "";
}

/**
 * Which surface is on screen for `{ tab, layout }`. The PDF tab wins because it
 * is what is visible; the note view underneath it is remembered untouched, so
 * PDF → back returns to exactly the view the user left.
 */
export function currentNoteSurface({ tab, layout } = {}) {
  if (tab === NOTE_WORKSPACE_TAB.PDF) return NOTE_SURFACE.PDF;
  return layout === NOTE_LAYOUT.TEMPLATE
    ? NOTE_SURFACE.TEMPLATE_FORM
    : NOTE_SURFACE.FREEFORM;
}

/**
 * The state change selecting `surface` asks for. Selecting a note view sets
 * BOTH the tab and the layout (so a view chosen while the PDF is showing
 * genuinely appears); selecting the PDF sets only the tab and leaves the note
 * view — and therefore the export source — exactly as it was. An unknown
 * surface asks for nothing.
 */
export function noteSurfaceTransition(surface) {
  switch (surface) {
    case NOTE_SURFACE.TEMPLATE_FORM:
      return { tab: NOTE_WORKSPACE_TAB.NOTE, layout: NOTE_LAYOUT.TEMPLATE };
    case NOTE_SURFACE.FREEFORM:
      return { tab: NOTE_WORKSPACE_TAB.NOTE, layout: NOTE_LAYOUT.NATURAL };
    case NOTE_SURFACE.PDF:
      return { tab: NOTE_WORKSPACE_TAB.PDF };
    default:
      return null;
  }
}
