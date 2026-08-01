// src/lib/editorToolbarState.test.js
//
// The gate that stops the formatting toolbar, Undo/Redo and AI Refine acting
// on a Free-form editor the user cannot see.

import {
  FREEFORM_LAYOUT,
  TEMPLATE_LAYOUT,
  canRefine,
  canRevertRefine,
  isFreeformEditingEnabled,
} from "./editorToolbarState";

describe("isFreeformEditingEnabled", () => {
  const live = { hasNote: true, hasEditor: true, noteLayout: FREEFORM_LAYOUT };

  test("enabled only with a note, an editor, and the Free-form view visible", () => {
    expect(isFreeformEditingEnabled(live)).toBe(true);
  });

  test("DISABLED while the Template form is visible", () => {
    // The Free-form editor is only hidden with display:none — an enabled
    // control would dispatch into it and persist the result.
    expect(isFreeformEditingEnabled({ ...live, noteLayout: TEMPLATE_LAYOUT })).toBe(false);
  });

  test("DISABLED with no note open", () => {
    expect(isFreeformEditingEnabled({ ...live, hasNote: false })).toBe(false);
  });

  test("DISABLED when the editor is not available", () => {
    expect(isFreeformEditingEnabled({ ...live, hasEditor: false })).toBe(false);
  });

  test("an unknown view is treated as not-Free-form", () => {
    expect(isFreeformEditingEnabled({ ...live, noteLayout: undefined })).toBe(false);
    expect(isFreeformEditingEnabled({ ...live, noteLayout: "something-new" })).toBe(false);
  });

  test("always returns a real boolean, never a truthy value", () => {
    expect(isFreeformEditingEnabled({ hasNote: 0, hasEditor: null, noteLayout: FREEFORM_LAYOUT }))
      .toBe(false);
  });

  test("the stored view identifiers are unchanged", () => {
    // MainArea and the per-view autosave status both depend on these values.
    expect(FREEFORM_LAYOUT).toBe("natural");
    expect(TEMPLATE_LAYOUT).toBe("template");
  });
});

describe("canRefine", () => {
  const ready = { freeformEnabled: true, hasContent: true, isLoading: false };

  test("allowed on a visible Free-form note with content and no request running", () => {
    expect(canRefine(ready)).toBe(true);
  });

  test("never allowed from the Template form", () => {
    expect(canRefine({ ...ready, freeformEnabled: false })).toBe(false);
  });

  test("never allowed with no usable content", () => {
    expect(canRefine({ ...ready, hasContent: false })).toBe(false);
  });

  test("blocked while a request is in flight — no duplicate submissions", () => {
    expect(canRefine({ ...ready, isLoading: true })).toBe(false);
  });

  test("becomes available again once the request settles", () => {
    expect(canRefine({ ...ready, isLoading: false })).toBe(true);
  });
});

describe("canRevertRefine", () => {
  const ready = { freeformEnabled: true, hasBackup: true, isLoading: false };

  test("allowed when the visible note has its own backup", () => {
    expect(canRevertRefine(ready)).toBe(true);
  });

  test("not offered when this note has no backup", () => {
    // Another note's backup is never reachable — hasBackup is resolved per note.
    expect(canRevertRefine({ ...ready, hasBackup: false })).toBe(false);
  });

  test("not offered from the Template form", () => {
    expect(canRevertRefine({ ...ready, freeformEnabled: false })).toBe(false);
  });

  test("blocked while a refine is in flight", () => {
    expect(canRevertRefine({ ...ready, isLoading: true })).toBe(false);
  });
});
