// src/components/mobile/PhoneShellBoundary.test.js
//
// THE SHELL BOUNDARY, rendered through App.js (Phase 8E.1).
//
// A phone viewport renders the phone shell and none of the desktop panes; a
// desktop viewport renders the desktop shell exactly as before and no phone
// chrome. Heavy desktop panes are replaced with named stand-ins — what is under
// test is which composition App.js chooses, not the panes themselves.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import App from "../../App";
import { AppStateContext } from "../../context/AppStateContext";
import { MOBILE_TAB_LABEL, MOBILE_TAB_ORDER, PHONE_SHELL_QUERY } from "../../lib/mobileShell";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../Sidebar", () => {
  const mockReact = require("react");
  return function MockSidebar() {
    return mockReact.createElement("aside", { id: "leftPane", "data-testid": "desktop-sidebar" });
  };
});
jest.mock("../MiddlePane", () => {
  const mockReact = require("react");
  return function MockMiddlePane() {
    return mockReact.createElement("aside", { id: "middlePane", "data-testid": "desktop-notes-pane" });
  };
});
jest.mock("../MainArea", () => {
  const mockReact = require("react");
  return function MockMainArea() {
    return mockReact.createElement("main", { "data-testid": "note-workspace" });
  };
});
jest.mock("../SettingsModal", () => () => null);
jest.mock("../template/TemplateBuilderModal", () => {
  const mockReact = require("react");
  return function MockTemplateBuilderModal({ open }) {
    return mockReact.createElement("div", { "data-testid": "template-builder", "data-open": open ? "true" : "false" });
  };
});
jest.mock("./MobilePdfViewer", () => () => null);
jest.mock("../../lib/templateMigration", () => ({
  runTemplateMigration: () => ({ status: "skipped" }),
  TEMPLATE_MIGRATION_STATUS: { FAILED: "failed", SKIPPED: "skipped" },
}));

const realMatchMedia = window.matchMedia;

function stubViewport({ phone }) {
  window.matchMedia = (query) => ({
    matches: query === PHONE_SHELL_QUERY ? phone : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
}

const APP_STATE = {
  state: { projectData: [], folderMap: {}, rootFolders: [], rootFolderNotesMap: {} },
  rootNotes: [{ id: "rn1", title: "Scratch" }],
  currentNoteId: "rn1",
  getNotePdf: () => null,
  setActiveNoteView: () => {},
  activeProjectId: null,
  activeFolderId: null,
  workspace: "projects",
  noteWorkspaceTab: "note",
  activeNoteView: "natural",
  listAllPdfs: () => [],
  persistenceError: null,
  clearPersistenceError: () => {},
};

let host;
let root;

function renderApp() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <AppStateContext.Provider value={APP_STATE}>
        <App />
      </AppStateContext.Provider>
    )
  );
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
  window.matchMedia = realMatchMedia;
});

describe("1/3. a phone viewport uses the phone shell", () => {
  test("the phone composition renders, with none of the desktop panes squeezed into it", () => {
    stubViewport({ phone: true });
    renderApp();
    expect(host.querySelector('[data-nw-shell="phone"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="desktop-sidebar"]')).toBeNull();
    expect(host.querySelector('[data-testid="desktop-notes-pane"]')).toBeNull();
    expect(host.querySelector("#leftPane")).toBeNull();
    // The shared note workspace is composed INTO the phone shell.
    const note = host.querySelector('[data-nw-phone-screen="note"] [data-testid="note-workspace"]');
    expect(note).not.toBeNull();
    // No desktop Listen In dialog frame is mounted beside it.
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  test("4/5. bottom navigation: Projects / Note / Listen In / PDFs / More, current tab marked accessibly", () => {
    stubViewport({ phone: true });
    renderApp();
    const nav = host.querySelector('nav[data-nw-phone-nav]');
    expect(nav.getAttribute("aria-label")).toBe("Main");
    const items = [...nav.querySelectorAll("button")];
    expect(items.map((b) => b.textContent.trim())).toEqual(MOBILE_TAB_ORDER.map((t) => MOBILE_TAB_LABEL[t]));
    const current = items.filter((b) => b.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    // A note is open in this fixture, so the shell opens on Note (initialMobileTab).
    expect(current[0].textContent.trim()).toBe("Note");
    // Each item is a real button with a visible text label beside its icon.
    for (const item of items) {
      expect(item.querySelector(".nw-phone-nav__label").textContent.length).toBeGreaterThan(0);
      expect(item.querySelector("svg").closest("[aria-hidden='true']")).not.toBeNull();
    }
  });
});

describe("the phone's Template Library control opens the SAME App-owned Builder dialog", () => {
  test("note bar top-right → TemplateBuilderModal opens; the note-mode segment is a different control; no More entry", () => {
    stubViewport({ phone: true });
    renderApp();
    expect(host.querySelector('[data-testid="template-builder"]').getAttribute("data-open")).toBe("false");
    const bar = host.querySelector('[data-nw-phone-screen="note"] [data-nw-phone-notebar]');
    const builder = bar.querySelector("[data-nw-phone-template-library]");
    const modeTemplate = bar.querySelector('[data-nw-phone-view="template-form"]');
    expect(builder).not.toBeNull();
    expect(modeTemplate).not.toBeNull();
    expect(builder).not.toBe(modeTemplate);
    act(() => builder.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector('[data-testid="template-builder"]').getAttribute("data-open")).toBe("true");
    expect(host.querySelector('[data-nw-phone-more="template-library"]')).toBeNull();
    // The dialog is rendered INSIDE the phone shell (after its navigation),
    // so it gets the shell's layout context and its stylesheet — the phone
    // presentation of the Template Library depends on both.
    const shell = host.querySelector('[data-nw-shell="phone"]');
    const dialog = host.querySelector('[data-testid="template-builder"]');
    expect(shell.contains(dialog)).toBe(true);
    expect(dialog.parentElement).toBe(shell);
    const nav = host.querySelector("[data-nw-phone-nav]");
    expect(nav.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("2. a desktop viewport keeps the desktop shell", () => {
  test("sidebar, notes pane and note workspace render; no phone chrome exists", () => {
    stubViewport({ phone: false });
    renderApp();
    expect(host.querySelector('[data-testid="desktop-sidebar"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="desktop-notes-pane"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="note-workspace"]')).not.toBeNull();
    expect(host.querySelector('[data-nw-shell="phone"]')).toBeNull();
    expect(host.querySelector("[data-nw-phone-nav]")).toBeNull();
    expect(host.querySelector("[data-listen-in-mini-bar]")).toBeNull();
    // The desktop shell's own frame is unchanged.
    expect(host.querySelector(".flex.h-screen")).not.toBeNull();
  });
});
