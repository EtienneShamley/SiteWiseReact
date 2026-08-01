// The note-view identifiers and their user-facing names (src/lib/noteViews.js).
//
// These were previously defined alongside the removed temporary editing-history
// model. Moving them must not change a single visible character: the tab
// labels, every accessible name and the per-view autosave status all read from
// here, and the names are a recorded product decision (docs/ARCHITECTURE.md →
// Note view naming).
import { NOTE_VIEW, NOTE_VIEW_LABEL, isNoteView, noteViewLabel } from "./noteViews";

test("the view identifiers are unchanged", () => {
  expect(NOTE_VIEW.FREEFORM).toBe("freeform");
  expect(NOTE_VIEW.TEMPLATE_FORM).toBe("templateForm");
});

test("the user-facing labels are exactly Free-form note and Template form", () => {
  expect(NOTE_VIEW_LABEL[NOTE_VIEW.FREEFORM]).toBe("Free-form note");
  expect(NOTE_VIEW_LABEL[NOTE_VIEW.TEMPLATE_FORM]).toBe("Template form");
  expect(noteViewLabel(NOTE_VIEW.FREEFORM)).toBe("Free-form note");
  expect(noteViewLabel(NOTE_VIEW.TEMPLATE_FORM)).toBe("Template form");
});

test("an unknown view is not a view and has no label", () => {
  expect(isNoteView(NOTE_VIEW.FREEFORM)).toBe(true);
  expect(isNoteView(NOTE_VIEW.TEMPLATE_FORM)).toBe(true);
  expect(isNoteView("natural")).toBe(false); // the stored layout id, not a view id
  expect(isNoteView(undefined)).toBe(false);
  expect(noteViewLabel("whatever")).toBe("");
});
