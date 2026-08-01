// src/lib/noteViews.js
//
// The two views a note can be edited in, and their user-facing names.
//
// One definition, used by the note-view tab labels, every accessible name and
// the per-view autosave status, so the names can never drift. These identifiers
// were previously defined alongside the removed temporary editing-history
// model; they are note-view naming (see docs/ARCHITECTURE.md → Note view
// naming) and are deliberately independent of any history or save feature.
//
// MainArea's stored layout identifiers are unchanged ("natural" | "template");
// the values below are the view identifiers the status model is keyed by.
//
// Pure: no React, no storage, no DOM.

export const NOTE_VIEW = {
  FREEFORM: "freeform",
  TEMPLATE_FORM: "templateForm",
};

// User-facing names. "Free-form note" is unrestricted rich text; "Template
// form" is the structured company-template view assigned to this note. Neither
// is the Template Library (the reusable-template workspace).
export const NOTE_VIEW_LABEL = {
  [NOTE_VIEW.FREEFORM]: "Free-form note",
  [NOTE_VIEW.TEMPLATE_FORM]: "Template form",
};

export function isNoteView(view) {
  return view === NOTE_VIEW.FREEFORM || view === NOTE_VIEW.TEMPLATE_FORM;
}

export function noteViewLabel(view) {
  return NOTE_VIEW_LABEL[view] || "";
}
