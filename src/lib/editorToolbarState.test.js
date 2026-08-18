// src/lib/editorToolbarState.test.js
//
// The gate that stops the formatting toolbar, Undo/Redo and AI Refine acting
// on a Free-form editor the user cannot see.

import * as editorToolbarState from "./editorToolbarState";
import {
  FREEFORM_LAYOUT,
  TEMPLATE_LAYOUT,
  TEMPLATE_TOOLBAR_HINT,
  TOOLBAR_OWNER,
  applyRowEditorRegistration,
  canRefine,
  canRevertRefine,
  isFreeformEditingEnabled,
  isToolbarControlAllowed,
  resolveToolbarOwner,
} from "./editorToolbarState";
import { SECTION_EDITOR_SCOPE, sectionEditorIdentity } from "./sectionEditorRegistry";

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
    hasTemplateSectionEditor: false,
  };

  test("Free-form view: the Free-form editor owns the toolbar, as it always has", () => {
    expect(resolveToolbarOwner(base)).toBe(TOOLBAR_OWNER.FREEFORM);
  });

  test("Free-form view keeps its owner even while a Template Section editor exists", () => {
    // Ownership follows the VISIBLE view, never whatever editor happens to be
    // alive — this is what keeps the two histories and surfaces separate.
    expect(
      resolveToolbarOwner({ ...base, hasTemplateSectionEditor: true })
    ).toBe(TOOLBAR_OWNER.FREEFORM);
  });

  test("Template form with an ACTIVE SECTION: that Section's shared editor owns it", () => {
    expect(
      resolveToolbarOwner({
        ...base,
        noteLayout: TEMPLATE_LAYOUT,
        hasTemplateSectionEditor: true,
      })
    ).toBe(TOOLBAR_OWNER.TEMPLATE_SECTION);
  });

  test("Template form with NO active Section: nobody owns it", () => {
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
        hasTemplateSectionEditor: true,
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
      hasTemplateSectionEditor: true,
    };
    expect(resolveToolbarOwner(inTemplate)).toBe(TOOLBAR_OWNER.TEMPLATE_SECTION);
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

describe("the toolbar's permitted set is derived, not listed here", () => {
  test("no hand-maintained Section control set remains in this module", () => {
    // Since 2026-08-18 the permitted controls are derived from the owning
    // editor's schema (src/lib/editorCapabilities.js); this module keeps only
    // the generic gate.
    expect(require("./editorToolbarState").SECTION_TOOLBAR_CONTROLS).toBeUndefined();
  });

  test("the generic gate: a set permits exactly its keys; null permits everything", () => {
    const set = new Set(["bold", "indent", "outdent"]);
    expect(isToolbarControlAllowed(set, "bold")).toBe(true);
    expect(isToolbarControlAllowed(set, "table")).toBe(false);
    for (const key of ["imageUpload", "table", "heading", "bold"]) {
      expect(isToolbarControlAllowed(null, key)).toBe(true);
    }
    // There is deliberately no paragraph-indent control anywhere: only list
    // nesting is exposed (asserted against the capability key list).
    const { TOOLBAR_CONTROL_KEYS } = require("./editorCapabilities");
    expect(TOOLBAR_CONTROL_KEYS.filter((k) => /indent|outdent/i.test(k)).sort()).toEqual(["indent", "outdent"]);
  });

  test("there is an understandable explanation for the disabled state", () => {
    expect(TEMPLATE_TOOLBAR_HINT).toBe("Select a section to use formatting.");
  });
});

/* ------------------------------------------------------------------------ */
/* Editor identity across templates and immutable versions                   */
/* ------------------------------------------------------------------------ */
//
// Phase G retired the legacy per-item row editor and, with it, this module's
// TEMPLATE_FOCUS / nextActiveTextRow / canCommitRowEdit /
// templateRowEditorIdentity / resolveActiveRowIdentity. Identity now has ONE
// home — sectionEditorIdentity in sectionEditorRegistry.js — and it is
// scope-prefixed so nothing else can mint a token that collides with it.

describe("the legacy row-editor identity is gone; sectionEditorIdentity is the one home", () => {
  test("editorToolbarState no longer exports the retired identity functions", () => {
    for (const name of [
      "TEMPLATE_FOCUS",
      "nextActiveTextRow",
      "canCommitRowEdit",
      "templateRowEditorIdentity",
      "resolveActiveRowIdentity",
    ]) {
      expect({ name, present: name in editorToolbarState }).toEqual({ name, present: false });
    }
  });

  test("the surviving toolbar-owner surface is intact", () => {
    expect(typeof applyRowEditorRegistration).toBe("function");
    expect(typeof resolveToolbarOwner).toBe("function");
    expect(TOOLBAR_OWNER.TEMPLATE_SECTION).toBeTruthy();
  });

  test("the Section identity is scope-prefixed and still separates templates, versions, notes and custom rows", () => {
    const base = {
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      rowId: "row-1",
    };
    const token = sectionEditorIdentity(base);
    expect(JSON.parse(token)[0]).toBe(SECTION_EDITOR_SCOPE);
    expect(token).toBe(sectionEditorIdentity({ ...base }));
    expect(token).not.toBe(sectionEditorIdentity({ ...base, templateId: "tpl-2" }));
    expect(token).not.toBe(sectionEditorIdentity({ ...base, templateVersionId: "ver-2" }));
    expect(token).not.toBe(sectionEditorIdentity({ ...base, noteId: "note-2" }));
    expect(token).not.toBe(sectionEditorIdentity({ ...base, isCustomRow: true }));
    expect(sectionEditorIdentity({ ...base, noteId: null })).toBeNull();
    expect(sectionEditorIdentity({ ...base, rowId: null })).toBeNull();
    expect(sectionEditorIdentity()).toBeNull();
  });

  test("a stale registration from a previous template cannot be mistaken for the new one", () => {
    const oldIdentity = sectionEditorIdentity({
      noteId: "note-1",
      templateId: "tpl-1",
      templateVersionId: "ver-1",
      rowId: "row-1",
    });
    const newIdentity = sectionEditorIdentity({
      noteId: "note-1",
      templateId: "tpl-2",
      templateVersionId: "ver-9",
      rowId: "row-1", // the SAME row id in the newly assigned template
    });
    expect(newIdentity).not.toBe(oldIdentity);
    const registered = applyRowEditorRegistration(null, {
      identity: newIdentity,
      editor: { name: "new" },
    });
    // The old editor's cleanup cannot clear the new registration.
    expect(applyRowEditorRegistration(registered, { identity: oldIdentity, editor: null })).toBe(
      registered
    );
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
