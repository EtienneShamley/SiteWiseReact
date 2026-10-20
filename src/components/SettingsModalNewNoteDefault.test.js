/**
 * @jest-environment jsdom
 */
// src/components/SettingsModalNewNoteDefault.test.js
//
// THE "NEW NOTE DEFAULT" CONTROL (2026-10-20) in the one Settings panel that
// both the desktop sidebar and the phone's More screen open. Mounted for real;
// the contexts the panel reads are the smallest values it needs, as in
// SettingsModalPhotoDetails.test.js.

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("../context/ThemeContext", () => ({ useTheme: () => ({ theme: "light", toggleTheme: () => {} }) }));
jest.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: { uid: "uid-a", email: "a@example.com", emailVerified: true },
    signOut: async () => {},
    resendVerification: async () => {},
  }),
}));
let mockScope = null;
jest.mock("../context/DataScopeContext", () => ({ useOptionalDataScope: () => mockScope }));

/* eslint-disable import/first -- jest.mock calls must precede the imports they replace */
import SettingsModal, {
  NEW_NOTE_DEFAULT_LABEL,
  NEW_NOTE_DEFAULT_NOTE,
} from "./SettingsModal";
import { DURABLE_SCOPE_KIND, __resetDurableStorageForTests, setDurableScope } from "../lib/durableStorage";
import {
  NEW_NOTE_DEFAULT,
  NEW_NOTE_DEFAULT_STORAGE_KEY,
  loadNewNoteDefault,
} from "../lib/newNoteDefaultPreference";
/* eslint-enable import/first */

global.IS_REACT_ACT_ENVIRONMENT = true;

const A = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-alice" };
const B = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-bob" };

let host;
let root;

function render(open) {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  act(() => root.render(<SettingsModal open={open} onClose={() => {}} />));
}

const select = () => host.querySelector("#nw-settings-new-note-default");
const choose = (value) =>
  act(() => {
    const el = select();
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  setDurableScope(A);
  mockScope = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("18. Settings exposes the Free-form / Template default", () => {
  test("a labelled select with the two choices and its note, defaulting to Free-form; opening writes nothing", () => {
    render(true);
    const el = select();
    expect(el.tagName).toBe("SELECT");
    expect(host.querySelector('label[for="nw-settings-new-note-default"]').textContent).toBe(NEW_NOTE_DEFAULT_LABEL);
    expect(NEW_NOTE_DEFAULT_LABEL).toBe("New note default");
    expect(Array.from(el.options).map((o) => [o.value, o.textContent])).toEqual([
      ["freeform", "Free-form"],
      ["template", "Template"],
    ]);
    expect(el.value).toBe(NEW_NOTE_DEFAULT.FREEFORM);
    expect(host.querySelector("#nw-settings-new-note-default-note").textContent).toBe(NEW_NOTE_DEFAULT_NOTE);
    expect(el.getAttribute("aria-describedby")).toBe("nw-settings-new-note-default-note");
    expect(localStorage.getItem(`notewise-workspace-v1/ws-alice/${NEW_NOTE_DEFAULT_STORAGE_KEY}`)).toBeNull();
  });

  test("shown without a signed-in workspace session too (it is not a cloud setting)", () => {
    mockScope = null;
    render(true);
    expect(select()).not.toBeNull();
  });
});

describe("19. the choice persists through the existing preference storage", () => {
  test("a change is stored for the workspace and shown again on reopen", () => {
    render(true);
    choose(NEW_NOTE_DEFAULT.TEMPLATE);
    expect(select().value).toBe(NEW_NOTE_DEFAULT.TEMPLATE);
    expect(loadNewNoteDefault()).toBe(NEW_NOTE_DEFAULT.TEMPLATE);
    expect(localStorage.getItem(`notewise-workspace-v1/ws-alice/${NEW_NOTE_DEFAULT_STORAGE_KEY}`)).toBe("template");
    render(false);
    render(true);
    expect(select().value).toBe(NEW_NOTE_DEFAULT.TEMPLATE);
  });

  test("reopening re-reads the ACTIVE workspace's value", () => {
    render(true);
    choose(NEW_NOTE_DEFAULT.TEMPLATE);
    render(false);
    setDurableScope(B);
    render(true);
    expect(select().value).toBe(NEW_NOTE_DEFAULT.FREEFORM);
  });
});
