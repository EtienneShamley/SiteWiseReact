// src/lib/noteSurfaces.test.js
//
// The open note's surfaces as ONE navigation system (Template form / Free-form
// note / PDF): the pure mapping between a surface and the two transient state
// values that render it (activeNoteView + noteWorkspaceTab).
import { NOTE_VIEW, NOTE_VIEW_LABEL } from "./noteViews";
import {
  NOTE_LAYOUT,
  NOTE_SURFACE,
  NOTE_SURFACE_HINT,
  NOTE_SURFACE_LABEL,
  NOTE_SURFACE_ORDER,
  NOTE_WORKSPACE_TAB,
  currentNoteSurface,
  isNoteSurface,
  noteSurfaceLabel,
  noteSurfaceTransition,
} from "./noteSurfaces";

describe("the surface catalogue", () => {
  test("exactly three surfaces, note views first, PDF last", () => {
    expect(NOTE_SURFACE_ORDER).toEqual([
      NOTE_SURFACE.TEMPLATE_FORM,
      NOTE_SURFACE.FREEFORM,
      NOTE_SURFACE.PDF,
    ]);
    for (const s of NOTE_SURFACE_ORDER) expect(isNoteSurface(s)).toBe(true);
    expect(isNoteSurface("preview")).toBe(false);
    expect(isNoteSurface(null)).toBe(false);
  });

  test("the two note-view labels are the ONE existing definition, not retyped", () => {
    expect(NOTE_SURFACE_LABEL[NOTE_SURFACE.TEMPLATE_FORM]).toBe(NOTE_VIEW_LABEL[NOTE_VIEW.TEMPLATE_FORM]);
    expect(NOTE_SURFACE_LABEL[NOTE_SURFACE.FREEFORM]).toBe(NOTE_VIEW_LABEL[NOTE_VIEW.FREEFORM]);
    expect(NOTE_SURFACE_LABEL[NOTE_SURFACE.PDF]).toBe("PDF");
    expect(noteSurfaceLabel("nope")).toBe("");
    for (const s of NOTE_SURFACE_ORDER) {
      expect(typeof NOTE_SURFACE_HINT[s]).toBe("string");
      expect(NOTE_SURFACE_HINT[s].length).toBeGreaterThan(10);
    }
  });
});

describe("currentNoteSurface — derived from the two values that render it", () => {
  test("the note tab shows the note view", () => {
    expect(currentNoteSurface({ tab: NOTE_WORKSPACE_TAB.NOTE, layout: NOTE_LAYOUT.TEMPLATE })).toBe(NOTE_SURFACE.TEMPLATE_FORM);
    expect(currentNoteSurface({ tab: NOTE_WORKSPACE_TAB.NOTE, layout: NOTE_LAYOUT.NATURAL })).toBe(NOTE_SURFACE.FREEFORM);
  });

  test("the PDF tab wins regardless of the remembered note view", () => {
    expect(currentNoteSurface({ tab: NOTE_WORKSPACE_TAB.PDF, layout: NOTE_LAYOUT.TEMPLATE })).toBe(NOTE_SURFACE.PDF);
    expect(currentNoteSurface({ tab: NOTE_WORKSPACE_TAB.PDF, layout: NOTE_LAYOUT.NATURAL })).toBe(NOTE_SURFACE.PDF);
  });

  test("missing state degrades to the Free-form note (the app default)", () => {
    expect(currentNoteSurface({})).toBe(NOTE_SURFACE.FREEFORM);
    expect(currentNoteSurface()).toBe(NOTE_SURFACE.FREEFORM);
  });
});

describe("noteSurfaceTransition — what selecting a surface asks for", () => {
  test("a note view sets BOTH the tab and the layout, so it appears even from the PDF", () => {
    expect(noteSurfaceTransition(NOTE_SURFACE.TEMPLATE_FORM)).toEqual({ tab: "note", layout: "template" });
    expect(noteSurfaceTransition(NOTE_SURFACE.FREEFORM)).toEqual({ tab: "note", layout: "natural" });
  });

  test("the PDF sets ONLY the tab — the note view (and so the export source) is untouched", () => {
    const t = noteSurfaceTransition(NOTE_SURFACE.PDF);
    expect(t).toEqual({ tab: "pdf" });
    expect("layout" in t).toBe(false);
  });

  test("an unknown surface asks for nothing", () => {
    expect(noteSurfaceTransition("preview")).toBeNull();
    expect(noteSurfaceTransition(undefined)).toBeNull();
  });

  test("round trip: Template form → PDF → back lands on the Template form", () => {
    let state = { tab: "note", layout: "template" };
    const apply = (surface) => {
      const next = noteSurfaceTransition(surface);
      state = { ...state, ...(next || {}) };
    };
    apply(NOTE_SURFACE.PDF);
    expect(currentNoteSurface(state)).toBe(NOTE_SURFACE.PDF);
    expect(state.layout).toBe("template");
    apply(NOTE_SURFACE.TEMPLATE_FORM);
    expect(currentNoteSurface(state)).toBe(NOTE_SURFACE.TEMPLATE_FORM);
    apply(NOTE_SURFACE.FREEFORM);
    expect(currentNoteSurface(state)).toBe(NOTE_SURFACE.FREEFORM);
    expect(state.tab).toBe("note");
  });
});
