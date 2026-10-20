// src/lib/newNoteDefaultPreference.test.js
//
// THE "NEW NOTE DEFAULT" PREFERENCE (2026-10-20) — stored through the same
// scope-following UI-preference helpers as Photo details
// (src/lib/durableStorage.js), so the scope switches here are the real
// mechanism. The creation-side rule is proved through the real provider in
// newNoteDefaultContext.test.js.
import {
  DURABLE_SCOPE_KIND,
  __resetDurableStorageForTests,
  scopedStorageKey,
  setDurableScope,
} from "./durableStorage";
import {
  NEW_NOTE_DEFAULT,
  NEW_NOTE_DEFAULTS,
  NEW_NOTE_DEFAULT_INITIAL,
  NEW_NOTE_DEFAULT_STORAGE_KEY,
  loadNewNoteDefault,
  newNoteLayout,
  normalizeNewNoteDefault,
  saveNewNoteDefault,
} from "./newNoteDefaultPreference";
import { NOTE_LAYOUT } from "./noteSurfaces";

const LOCAL = { kind: DURABLE_SCOPE_KIND.LOCAL };
const A = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-alice" };
const B = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-bob" };

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
});

describe("the setting", () => {
  test("two choices; first use is Free-form, and reading it writes nothing", () => {
    expect(NEW_NOTE_DEFAULTS).toEqual(["freeform", "template"]);
    expect(NEW_NOTE_DEFAULT_INITIAL).toBe(NEW_NOTE_DEFAULT.FREEFORM);
    setDurableScope(A);
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.FREEFORM);
    expect(localStorage.getItem(scopedStorageKey(NEW_NOTE_DEFAULT_STORAGE_KEY, A))).toBeNull();
  });

  test("19. an explicit choice persists in the active scope's key", () => {
    setDurableScope(A);
    expect(saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE)).toBe(true);
    expect(localStorage.getItem(scopedStorageKey(NEW_NOTE_DEFAULT_STORAGE_KEY, A))).toBe("template");
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.TEMPLATE);
    expect(saveNewNoteDefault(NEW_NOTE_DEFAULT.FREEFORM)).toBe(true);
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.FREEFORM);
  });

  test("scoped per workspace, and the pre-account browser has its own", () => {
    setDurableScope(A);
    saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE);
    setDurableScope(B);
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.FREEFORM);
    setDurableScope(LOCAL);
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.FREEFORM);
    setDurableScope(A);
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.TEMPLATE);
  });

  test("an unknown value is refused on write and read as the default", () => {
    setDurableScope(A);
    expect(saveNewNoteDefault("pdf")).toBe(false);
    expect(normalizeNewNoteDefault("natural")).toBeNull();
    localStorage.setItem(scopedStorageKey(NEW_NOTE_DEFAULT_STORAGE_KEY, A), "garbage");
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.FREEFORM);
  });

  test("storage that throws reads as the default and reports a failed write", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadNewNoteDefault(broken, A)).toBe(NEW_NOTE_DEFAULT.FREEFORM);
    expect(saveNewNoteDefault(NEW_NOTE_DEFAULT.TEMPLATE, broken)).toBe(false);
  });
});

describe("the rule", () => {
  test("maps the choice onto the note view a new note opens in", () => {
    expect(newNoteLayout(NEW_NOTE_DEFAULT.TEMPLATE)).toBe(NOTE_LAYOUT.TEMPLATE);
    expect(newNoteLayout(NEW_NOTE_DEFAULT.FREEFORM)).toBe(NOTE_LAYOUT.NATURAL);
    expect(newNoteLayout(undefined)).toBe(NOTE_LAYOUT.NATURAL);
  });
});
