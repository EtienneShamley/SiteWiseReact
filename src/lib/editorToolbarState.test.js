// src/lib/editorToolbarState.test.js
//
// The gate that stops the formatting toolbar, Undo/Redo and AI Refine acting
// on a Free-form editor the user cannot see.

import {
  FREEFORM_LAYOUT,
  TEMPLATE_FOCUS,
  TEMPLATE_LAYOUT,
  TEMPLATE_TEXT_CONTROLS,
  TEMPLATE_TOOLBAR_HINT,
  TOOLBAR_OWNER,
  applyRowEditorRegistration,
  canCommitRowEdit,
  canRefine,
  canRevertRefine,
  isFreeformEditingEnabled,
  isToolbarControlAllowed,
  nextActiveTextRow,
  resolveActiveRowIdentity,
  resolveToolbarOwner,
  templateRowEditorIdentity,
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

/* ------------------------------------------------------------------------ */
/* Toolbar ownership                                                         */
/* ------------------------------------------------------------------------ */

describe("resolveToolbarOwner", () => {
  const base = {
    hasNote: true,
    noteLayout: FREEFORM_LAYOUT,
    hasFreeformEditor: true,
    hasTemplateRowEditor: false,
  };

  test("Free-form view: the Free-form editor owns the toolbar, as it always has", () => {
    expect(resolveToolbarOwner(base)).toBe(TOOLBAR_OWNER.FREEFORM);
  });

  test("Free-form view keeps its owner even while a Template row editor exists", () => {
    // Ownership follows the VISIBLE view, never whatever editor happens to be
    // alive — this is what keeps the two histories and surfaces separate.
    expect(
      resolveToolbarOwner({ ...base, hasTemplateRowEditor: true })
    ).toBe(TOOLBAR_OWNER.FREEFORM);
  });

  test("Template form with an active Text answer: the row editor owns it", () => {
    expect(
      resolveToolbarOwner({
        ...base,
        noteLayout: TEMPLATE_LAYOUT,
        hasTemplateRowEditor: true,
      })
    ).toBe(TOOLBAR_OWNER.TEMPLATE_ROW);
  });

  test("Template form with NO active Text answer: nobody owns it", () => {
    // Crucially not the Free-form editor, which is merely hidden behind this
    // view: a control acting on it would edit a document nobody can see.
    expect(
      resolveToolbarOwner({ ...base, noteLayout: TEMPLATE_LAYOUT })
    ).toBe(TOOLBAR_OWNER.NONE);
  });

  test("no note open: nobody owns it, in either view", () => {
    expect(resolveToolbarOwner({ ...base, hasNote: false })).toBe(TOOLBAR_OWNER.NONE);
    expect(
      resolveToolbarOwner({
        ...base,
        hasNote: false,
        noteLayout: TEMPLATE_LAYOUT,
        hasTemplateRowEditor: true,
      })
    ).toBe(TOOLBAR_OWNER.NONE);
  });

  test("no Free-form editor yet: nobody owns it", () => {
    expect(resolveToolbarOwner({ ...base, hasFreeformEditor: false })).toBe(
      TOOLBAR_OWNER.NONE
    );
  });

  test("switching views hands ownership over and back", () => {
    const inTemplate = {
      ...base,
      noteLayout: TEMPLATE_LAYOUT,
      hasTemplateRowEditor: true,
    };
    expect(resolveToolbarOwner(inTemplate)).toBe(TOOLBAR_OWNER.TEMPLATE_ROW);
    // Returning to Free-form restores Free-form ownership immediately.
    expect(resolveToolbarOwner({ ...inTemplate, noteLayout: FREEFORM_LAYOUT })).toBe(
      TOOLBAR_OWNER.FREEFORM
    );
  });

  test("an unknown layout owns nothing rather than defaulting to an editor", () => {
    expect(resolveToolbarOwner({ ...base, noteLayout: "something-else" })).toBe(
      TOOLBAR_OWNER.NONE
    );
  });

  test("called with nothing at all, it refuses rather than guessing", () => {
    expect(resolveToolbarOwner()).toBe(TOOLBAR_OWNER.NONE);
  });
});

describe("the Template Text control set", () => {
  test("supports exactly the approved controls", () => {
    for (const key of [
      "undo", "redo", "bold", "italic", "underline", "strike",
      "bulletList", "orderedList", "indent", "outdent",
      "alignLeft", "alignCenter", "alignRight", "alignJustify",
      "textColor", "highlightColor", "highlight",
      "link", "unlink", "clearFormatting",
    ]) {
      expect(isToolbarControlAllowed(TEMPLATE_TEXT_CONTROLS, key)).toBe(true);
    }
  });

  test("keeps embedded media, files, tables and document structure disabled", () => {
    for (const key of [
      "imageUpload", "imageUrl", "table", "tableOptions", "heading1",
      "blockquote", "codeBlock", "taskList", "horizontalRule",
      "subscript", "superscript", "fontFamily", "fontSize",
    ]) {
      expect(isToolbarControlAllowed(TEMPLATE_TEXT_CONTROLS, key)).toBe(false);
    }
  });

  test("indent/outdent are the ONLY indentation controls — list nesting only", () => {
    // There is deliberately no paragraph-indent control, so no margin or
    // padding can ever be stored on an answer.
    const indentish = [...TEMPLATE_TEXT_CONTROLS].filter((k) =>
      /indent|outdent/i.test(k)
    );
    expect(indentish.sort()).toEqual(["indent", "outdent"]);
  });

  test("the Free-form toolbar is unrestricted — null permits everything", () => {
    for (const key of ["imageUpload", "table", "heading1", "bold"]) {
      expect(isToolbarControlAllowed(null, key)).toBe(true);
    }
  });

  test("there is an understandable explanation for the disabled state", () => {
    expect(TEMPLATE_TOOLBAR_HINT).toBe("Select a Text answer to use formatting.");
  });
});

describe("which row owns the toolbar after a focus event", () => {
  test("focusing a Text answer makes that row the target", () => {
    expect(
      nextActiveTextRow({ target: TEMPLATE_FOCUS.ANSWER, rowId: "row-1", isTextRow: true })
    ).toBe("row-1");
  });

  test("focusing another Text answer moves the target immediately", () => {
    expect(
      nextActiveTextRow({ target: TEMPLATE_FOCUS.ANSWER, rowId: "row-2", isTextRow: true })
    ).toBe("row-2");
  });

  test("a structured field clears ownership entirely", () => {
    // number/date/time/checkbox/yes-no/dropdown/Photo/File are not rich text.
    expect(
      nextActiveTextRow({
        target: TEMPLATE_FOCUS.STRUCTURED,
        rowId: "row-3",
        isTextRow: false,
      })
    ).toBeNull();
  });

  test("an answer row that is not a Text field cannot become the target", () => {
    expect(
      nextActiveTextRow({ target: TEMPLATE_FOCUS.ANSWER, rowId: "row-4", isTextRow: false })
    ).toBeNull();
  });

  test("focusing a row LABEL never targets that row's answer", () => {
    expect(
      nextActiveTextRow({ target: TEMPLATE_FOCUS.LABEL, rowId: "row-5", isTextRow: true })
    ).toBeNull();
  });
});

describe("canCommitRowEdit", () => {
  test("the active row may commit its own edit", () => {
    expect(canCommitRowEdit("row-1", "row-1")).toBe(true);
  });

  test("a callback from a REPLACED editor cannot write into the new row", () => {
    // Switching rows destroys the previous editor; anything still holding a
    // reference to it must not be able to save into the row that replaced it.
    expect(canCommitRowEdit("row-2", "row-1")).toBe(false);
  });

  test("nothing may commit once no row is active (note or view switched away)", () => {
    expect(canCommitRowEdit(null, "row-1")).toBe(false);
    expect(canCommitRowEdit("row-1", null)).toBe(false);
    expect(canCommitRowEdit(null, null)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Editor identity across templates and immutable versions                   */
/* ------------------------------------------------------------------------ */
//
// A row id is not an identity. The same field id exists in every version
// published from a template (versions are immutable, so re-pinning a note
// carries the same ids forward) and may exist in another template entirely.
// Editing that id under a different template or version is a different answer
// with a different history, and must be a different editor.

describe("templateRowEditorIdentity", () => {
  const base = {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    rowId: "row-1",
    isCustomRow: false,
  };

  test("the same row id in two TEMPLATES is not the same editor", () => {
    expect(templateRowEditorIdentity(base)).not.toBe(
      templateRowEditorIdentity({ ...base, templateId: "tpl-2" })
    );
  });

  test("the same row id in two immutable VERSIONS is not the same editor", () => {
    expect(templateRowEditorIdentity(base)).not.toBe(
      templateRowEditorIdentity({ ...base, templateVersionId: "ver-2" })
    );
  });

  test("the same row id in two NOTES is not the same editor", () => {
    expect(templateRowEditorIdentity(base)).not.toBe(
      templateRowEditorIdentity({ ...base, noteId: "note-2" })
    );
  });

  test("a master row and a custom row sharing an id are not the same editor", () => {
    expect(templateRowEditorIdentity(base)).not.toBe(
      templateRowEditorIdentity({ ...base, isCustomRow: true })
    );
  });

  test("identical parts produce an identical, comparable token", () => {
    expect(templateRowEditorIdentity(base)).toBe(templateRowEditorIdentity({ ...base }));
  });

  test("a note with no template assigned still has a usable identity", () => {
    // An unassigned note has null templateId/templateVersionId; a custom row
    // still needs to be addressable, and null must compare equal to null.
    const unassigned = { noteId: "note-1", rowId: "row-1" };
    expect(templateRowEditorIdentity(unassigned)).toBe(
      templateRowEditorIdentity({ ...unassigned, templateId: null, templateVersionId: null })
    );
    expect(templateRowEditorIdentity(unassigned)).not.toBe(
      templateRowEditorIdentity({ ...unassigned, templateId: "tpl-1" })
    );
  });

  test("without a note or a row there is no editor to address", () => {
    expect(templateRowEditorIdentity({ ...base, noteId: null })).toBeNull();
    expect(templateRowEditorIdentity({ ...base, rowId: null })).toBeNull();
    expect(templateRowEditorIdentity()).toBeNull();
  });
});

describe("resolveActiveRowIdentity", () => {
  const parts = {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    rowId: "row-1",
    isCustomRow: false,
  };

  test("a row that still exists under the pinned version has an identity", () => {
    expect(resolveActiveRowIdentity({ ...parts, rowExists: true })).toBe(
      templateRowEditorIdentity(parts)
    );
  });

  test("a row that the NEW template/version does not contain has none", () => {
    // Which is what disables the Template rich-text controls and shows the
    // "Select a Text answer to use formatting." explanation.
    const identity = resolveActiveRowIdentity({ ...parts, rowExists: false });
    expect(identity).toBeNull();
    expect(
      resolveToolbarOwner({
        hasNote: true,
        noteLayout: TEMPLATE_LAYOUT,
        hasFreeformEditor: true,
        hasTemplateRowEditor: !!identity,
      })
    ).toBe(TOOLBAR_OWNER.NONE);
  });

  test("a row that survives a version change is a NEW identity, not the old one", () => {
    const before = resolveActiveRowIdentity({ ...parts, rowExists: true });
    const after = resolveActiveRowIdentity({
      ...parts,
      templateVersionId: "ver-2",
      rowExists: true,
    });
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

describe("stale callbacks cannot cross an identity change", () => {
  const oldIdentity = templateRowEditorIdentity({
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    rowId: "row-1",
  });
  const newIdentity = templateRowEditorIdentity({
    noteId: "note-1",
    templateId: "tpl-2",
    templateVersionId: "ver-9",
    rowId: "row-1", // the SAME row id in the newly assigned template
  });

  test("an update from the previous template's editor is refused", () => {
    expect(canCommitRowEdit(newIdentity, oldIdentity)).toBe(false);
    expect(canCommitRowEdit(newIdentity, newIdentity)).toBe(true);
  });

  test("an update is refused once no row is active at all", () => {
    expect(canCommitRowEdit(null, oldIdentity)).toBe(false);
    expect(canCommitRowEdit(oldIdentity, null)).toBe(false);
  });

  test("a BottomBar insertion aimed at the previous template is refused", () => {
    // The insertion resolves the target row's identity NOW; if the note has
    // been re-pinned, that no longer matches the registered editor.
    const registered = { identity: newIdentity };
    expect(canCommitRowEdit(registered.identity, oldIdentity)).toBe(false);
  });
});

describe("applyRowEditorRegistration", () => {
  const a = { identity: "id-a", editor: { name: "a" } };
  const b = { identity: "id-b", editor: { name: "b" } };

  test("registering takes ownership", () => {
    expect(applyRowEditorRegistration(null, a)).toEqual(a);
  });

  test("a new editor replaces the previous one", () => {
    expect(applyRowEditorRegistration(a, b)).toEqual(b);
  });

  test("the current owner may unregister itself", () => {
    expect(
      applyRowEditorRegistration(a, { identity: a.identity, editor: null })
    ).toBeNull();
  });

  test("a REPLACED editor's cleanup cannot unregister its replacement", () => {
    // This is the ordering hazard when a template change destroys one editor
    // and creates another: the old cleanup must not clear the new registration.
    const afterSwap = applyRowEditorRegistration(a, b);
    const afterStaleCleanup = applyRowEditorRegistration(afterSwap, {
      identity: a.identity,
      editor: null,
    });
    expect(afterStaleCleanup).toBe(afterSwap);
    expect(afterStaleCleanup.editor).toBe(b.editor);
  });

  test("an unregister with no identity changes nothing", () => {
    expect(applyRowEditorRegistration(a, { editor: null })).toBe(a);
  });

  test("registering the same identity and instance twice is a no-op", () => {
    const current = applyRowEditorRegistration(null, a);
    expect(applyRowEditorRegistration(current, a)).toBe(current);
  });

  test("the same identity with a NEW instance replaces it (a reload)", () => {
    const current = applyRowEditorRegistration(null, a);
    const reloaded = { identity: a.identity, editor: { name: "a2" } };
    expect(applyRowEditorRegistration(current, reloaded)).toEqual(reloaded);
  });

  test("unregistering when nothing is registered stays null", () => {
    expect(applyRowEditorRegistration(null, { identity: "id-a", editor: null })).toBeNull();
  });
});
