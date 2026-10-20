// src/components/mobile/MobileDrawer.test.js
//
// THE PHONE NAVIGATION DRAWER (2026-10-21), rendered: the real PhoneShell over
// the REAL Listen In provider and engine (fake recorder, injected transport)
// and the REAL Quick Add composer inside a stand-in note workspace — the same
// harness as PhoneShell.test.js. Layout facts jsdom cannot measure (safe
// areas, the one scroller, reduced motion, touch sizes) are asserted on the
// stylesheet that produces them.
import React, { useState } from "react";
import fs from "fs";
import path from "path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PhoneShell from "./PhoneShell";
import MobileDrawer, { MOBILE_DRAWER_CLOSE_LABEL, MOBILE_DRAWER_GROUP } from "./MobileDrawer";
import { MOBILE_DRAWER_OPEN_LABEL } from "./MobileDrawerTrigger";
import { AppStateContext } from "../../context/AppStateContext";
import { ThemeProvider } from "../../context/ThemeContext";
import { LiveTranscriptContext, LiveTranscriptProvider } from "../../context/LiveTranscriptContext";
import { getListenInEngine, resetListenInEnginesForTests } from "../../lib/listenIn/listenInEngine";
import { createListenInMemoryStore } from "../../lib/listenIn/listenInStore";
import { LISTEN_IN_MESSAGE, LISTEN_IN_STATE, MEETING_DELETE_CONFIRM } from "../../lib/listenIn/listenInModel";
import { resetMicrophoneOwnershipForTests } from "../../lib/microphoneOwnership";
import { MOBILE_TAB } from "../../lib/mobileShell";

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockScope = { uid: "uid-drawer", workspace: { id: "ws-drawer" } };
jest.mock("../../context/DataScopeContext", () => ({
  ...jest.requireActual("../../context/DataScopeContext"),
  useOptionalDataScope: () => mockScope,
}));
jest.mock("../../hooks/useTranscription", () => ({
  useTranscription: () => ({ transcribeBlob: jest.fn() }),
}));
jest.mock("../../hooks/useRefine", () => ({
  useRefine: () => ({ refineText: jest.fn() }),
}));
jest.mock("../MainArea", () => {
  const mockReact = require("react");
  const MockBottomBar = require("../BottomBar").default;
  const { QUICK_ADD_KIND: mockKind } = require("../../lib/quickAddTarget");
  return function MockMainArea() {
    mockReact.useEffect(() => {
      global.__drawerMainAreaMounts = (global.__drawerMainAreaMounts || 0) + 1;
    }, []);
    return mockReact.createElement(
      "main",
      { "data-testid": "note-workspace" },
      mockReact.createElement(MockBottomBar, {
        editor: {},
        onInsertText: () => true,
        target: { kind: mockKind.FREEFORM },
        capture: { image: true, file: true },
        onSendComposer: async () => ({ ok: true, deliveredIds: [], textDelivered: true, stale: false }),
      })
    );
  };
});
jest.mock("./MobilePdfViewer", () => {
  const mockReact = require("react");
  return function MockMobilePdfViewer({ doc }) {
    return mockReact.createElement("div", { "data-testid": "phone-pdf-viewer", "data-doc": doc.id });
  };
});

const SRC = path.join(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const CSS = read("components/mobile/mobileShell.css");
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = CSS.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[2] : null;
}

/* --------------------------------- fakes --------------------------------- */

class FakeMediaRecorder {
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || "";
    this.state = "inactive";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(16)], { type: this.mimeType }) });
    if (this.onstop) this.onstop();
  }
}

const realMediaRecorder = global.MediaRecorder;
const realMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
beforeAll(() => {
  global.MediaRecorder = FakeMediaRecorder;
});
afterAll(() => {
  global.MediaRecorder = realMediaRecorder;
  if (realMediaDevices) Object.defineProperty(navigator, "mediaDevices", realMediaDevices);
  else delete navigator.mediaDevices;
});

let getUserMedia;
let engine;

beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  global.__drawerMainAreaMounts = 0;
  getUserMedia = jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  engine = getListenInEngine(mockScope.uid, mockScope.workspace.id, {
    store: createListenInMemoryStore(),
    transcribe: async () => "captured words",
    summarise: async () => ({ ok: false }),
    recorderSupported: () => true,
  });
  jest.spyOn(window, "confirm").mockImplementation(() => false);
});

afterEach(() => {
  resetListenInEnginesForTests();
  jest.restoreAllMocks();
});

/* ---------------------------- application state --------------------------- */

const TREE = {
  projectData: [{ id: "p1", name: "Harbour Bridge" }],
  folderMap: {
    p1: [
      {
        id: "f1",
        name: "Site visits",
        notes: [
          { id: "n1", title: "Day 1" },
          { id: "n2", title: "Day 2" },
        ],
      },
    ],
  },
  rootFolders: [{ id: "rf1", name: "Personal" }],
  rootFolderNotesMap: { rf1: [{ id: "rfn1", title: "Ideas" }] },
};
const ROOT_NOTES = [{ id: "rn1", title: "Scratch" }];
const PDFS = { "pdf-1": { id: "pdf-1", name: "Drawings.pdf", updatedAt: 1 } };

const actions = {};
function freshActions() {
  for (const name of [
    "createProject",
    "renameProject",
    "deleteProject",
    "createFolder",
    "renameFolder",
    "deleteFolder",
    "createRootFolder",
    "renameRootFolder",
    "deleteRootFolder",
    "createRootNote",
    "renameRootNote",
    "deleteRootNote",
    "addNoteToFolder",
    "addNoteToRootFolder",
    "renameNote",
    "deleteNote",
  ]) {
    actions[name] = jest.fn();
  }
}

function TestAppState({ apiRef, initial = {}, children }) {
  const [selection, setSelection] = useState({
    activeProjectId: initial.activeProjectId || null,
    activeFolderId: initial.activeFolderId || null,
  });
  const [currentNoteId, setNote] = useState(initial.currentNoteId || null);
  const [currentPdfId, setCurrentPdfId] = useState(null);
  const [workspace, setWorkspace] = useState("projects");
  const [noteWorkspaceTab, setNoteWorkspaceTab] = useState("note");
  const [activeNoteView, setActiveNoteView] = useState("natural");
  const value = {
    state: TREE,
    rootNotes: ROOT_NOTES,
    ...selection,
    currentNoteId,
    currentPdfId,
    workspace,
    noteWorkspaceTab,
    activeNoteView,
    setWorkspace,
    setNoteWorkspaceTab,
    setActiveNoteView,
    setActiveSelection: (pid, fid) => {
      setSelection({ activeProjectId: pid ?? null, activeFolderId: fid ?? null });
      setNote(null);
    },
    clearActiveSelection: () => setSelection({ activeProjectId: null, activeFolderId: null }),
    setCurrentNoteId: setNote,
    setCurrentPdfId,
    getNotePdf: (nid) => (nid === "n1" ? "pdf-1" : null),
    getPdfDocById: (id) => PDFS[id] || null,
    listAllPdfs: () => Object.values(PDFS),
    createGlobalPdf: jest.fn(),
    ...actions,
    // Creating a root note opens it, as the real openNewNote does.
    createRootNote: (...args) => {
      actions.createRootNote(...args);
      setNote("rn-new");
    },
  };
  apiRef.current = value;
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

/* --------------------------------- harness -------------------------------- */

let host;
let root;
const app = { current: null };
let onOpenSettings;
let onOpenTemplateLibrary;

async function mount(initial = {}) {
  freshActions();
  onOpenSettings = jest.fn();
  onOpenTemplateLibrary = jest.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  await act(async () => {
    root.render(
      <ThemeProvider>
        <TestAppState apiRef={app} initial={initial}>
          <LiveTranscriptProvider>
            <PhoneShell onOpenSettings={onOpenSettings} onOpenTemplateLibrary={onOpenTemplateLibrary} />
          </LiveTranscriptProvider>
        </TestAppState>
      </ThemeProvider>
    );
  });
  await flush();
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const q = (selector) => host.querySelector(selector);
const qa = (selector) => Array.from(host.querySelectorAll(selector));
const drawer = () => q("[data-nw-phone-drawer]");
const panel = () => q("[data-nw-phone-drawer-panel]");
const body = () => q("[data-nw-phone-drawer-body]");
const visibleTrigger = () => q(".nw-phone-screen:not([hidden]) [data-nw-phone-drawer-trigger]");
const visible = () =>
  qa("[data-nw-phone-screen]")
    .filter((el) => !el.hidden)
    .map((el) => el.getAttribute("data-nw-phone-screen"));
const groupToggle = (group) => q(`[data-nw-phone-drawer-group-toggle="${group}"]`);
const groupItems = (group) => document.getElementById(groupToggle(group).getAttribute("aria-controls"));
const node = (kind, id) => q(`[data-nw-phone-drawer-node="${kind}"][data-nw-phone-drawer-node-id="${id}"]`);
const actionsToggle = (kind, id) =>
  q(`[data-nw-phone-drawer-actions-toggle="${kind}"][data-nw-phone-drawer-actions-id="${id}"]`);
const actionIn = (kind, id, label) =>
  Array.from(q(`[data-nw-phone-drawer-actions="${kind}"][data-nw-phone-drawer-actions-for="${id}"]`).querySelectorAll("button")).find(
    (b) => b.textContent.trim() === label
  );
const drawerMeetings = () => qa("[data-nw-phone-drawer-meeting]");
const meetingRow = (id) => q(`[data-nw-phone-drawer-meeting="${id}"]`);
const listenIn = (name) => q(`[data-nw-phone-screen="listen-in"] [data-listen-in-control="${name}"]`);
const tab = (id) => q(`[data-nw-phone-tab="${id}"]`);
const miniBar = () => q("[data-listen-in-mini-bar]");
const composer = () => q('[data-nw-phone-screen="note"] textarea');

async function click(el) {
  expect(el).toBeTruthy();
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}
async function key(target, keyName, init = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, ...init }));
  });
}
async function type(el, text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openDrawer() {
  await click(visibleTrigger());
  expect(drawer()).not.toBeNull();
}

/** One meeting with TWO recording legs (Stop recording / Start recording), completed. */
async function recordTwoLegMeeting() {
  await click(tab(MOBILE_TAB.LISTEN_IN));
  await click(listenIn("record")); // Start recording
  await click(listenIn("record")); // Stop recording
  await click(listenIn("record")); // Start recording again — same meeting
  await click(listenIn("record")); // Stop recording
  await click(listenIn("complete"));
  await flush();
  return engine.getSnapshot().session.sessionId;
}

/* ================================ 1–3 ===================================== */

describe("1–3. opening, closing, focus and the inert background", () => {
  test("1. ☰ opens a labelled modal dialog with Close focused; Close dismisses it and focus returns to ☰", async () => {
    await mount();
    expect(drawer()).toBeNull();
    const trigger = visibleTrigger();
    expect(trigger.getAttribute("aria-label")).toBe(MOBILE_DRAWER_OPEN_LABEL);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await openDrawer();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(panel().getAttribute("aria-labelledby")).textContent).toMatch(/NoteWise/);
    expect(trigger.getAttribute("aria-controls")).toBe(panel().id);
    const close = q("[data-nw-phone-drawer-close]");
    expect(close.getAttribute("aria-label")).toBe(MOBILE_DRAWER_CLOSE_LABEL);
    expect(document.activeElement).toBe(close);
    await click(close);
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("2. tapping the dimmed backdrop dismisses it", async () => {
    await mount();
    await openDrawer();
    const backdrop = q("[data-nw-phone-drawer-backdrop]");
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    await click(backdrop);
    expect(drawer()).toBeNull();
  });

  test("3. Escape closes; Tab stays inside; everything behind is inert while open and restored after", async () => {
    await mount();
    await openDrawer();
    const behind = Array.from(q("[data-nw-shell=phone]").children).filter((el) => el !== drawer());
    expect(behind.length).toBeGreaterThanOrEqual(2);
    for (const el of behind) expect(el.hasAttribute("inert")).toBe(true);
    expect(q("[data-nw-phone-nav]").hasAttribute("inert")).toBe(true);
    // Tab from the last control wraps to the first; Shift+Tab from the first to the last.
    const focusable = Array.from(panel().querySelectorAll("button")).filter((b) => !b.closest("[hidden]"));
    focusable[focusable.length - 1].focus();
    await key(focusable[focusable.length - 1], "Tab");
    expect(document.activeElement).toBe(focusable[0]);
    await key(focusable[0], "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    await key(document, "Escape");
    expect(drawer()).toBeNull();
    for (const el of behind) expect(el.hasAttribute("inert")).toBe(false);
  });

  test("every phone screen offers the ☰ in its header, and the bottom navigation is unchanged", async () => {
    await mount({ currentNoteId: "n1", activeProjectId: "p1", activeFolderId: "f1" });
    for (const screen of [MOBILE_TAB.PROJECTS, MOBILE_TAB.NOTE, MOBILE_TAB.LISTEN_IN, MOBILE_TAB.PDFS, MOBILE_TAB.MORE]) {
      expect(q(`[data-nw-phone-screen="${screen}"] [data-nw-phone-drawer-trigger]`)).not.toBeNull();
    }
    expect(qa("[data-nw-phone-tab]").map((b) => b.getAttribute("data-nw-phone-tab"))).toEqual([
      MOBILE_TAB.PROJECTS,
      MOBILE_TAB.NOTE,
      MOBILE_TAB.LISTEN_IN,
      MOBILE_TAB.PDFS,
      MOBILE_TAB.MORE,
    ]);
  });
});

/* ================================ 4–6 ===================================== */

describe("4/5. safe areas, motion and ONE scroll owner", () => {
  test("4. the panel keeps the top, bottom and left safe areas; it slides in, and not under reduced motion", () => {
    const panelRule = rule(".nw-phone-drawer__panel");
    expect(panelRule).toMatch(/padding-top: env\(safe-area-inset-top, 0px\);/);
    expect(panelRule).toMatch(/padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
    expect(panelRule).toMatch(/padding-left: env\(safe-area-inset-left, 0px\);/);
    expect(panelRule).toMatch(/animation: nw-phone-drawer-in/);
    expect(panelRule).toMatch(/width: min\(86vw, 22rem\);/);
    expect(rule(".nw-phone-drawer")).toMatch(/position: fixed;\s*\n\s*inset: 0;/);
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.nw-phone-drawer__panel,\s*\n\s*\.nw-phone-drawer__backdrop \{\s*\n\s*animation: none;/);
    expect(read("styles/nav.css")).toMatch(/@keyframes nw-phone-drawer-in/);
    // Touch-sized targets.
    for (const selector of [".nw-phone-drawer-trigger", ".nw-phone-drawer__close", ".nw-phone-drawer__more"]) {
      expect(rule(selector)).toMatch(/min-width: 44px;\s*\n\s*min-height: 44px;/);
    }
    for (const selector of [".nw-phone-drawer__item", ".nw-phone-drawer__group-toggle", ".nw-phone-drawer__action", ".nw-phone-drawer__create"]) {
      expect(rule(selector)).toMatch(/min-height: 44px;/);
    }
  });

  test("5. the body is the drawer's only scroller; header and footer sit outside it; meetings and the tree flow inside it", async () => {
    const drawerRules = [...CSS.matchAll(/(^|\n)(\.(?:dark )?\.?nw-phone-drawer[^{]*)\{([^}]*)\}/g)];
    const scrolling = drawerRules.filter((m) => /overflow(-y)?:\s*(auto|scroll)/.test(m[3])).map((m) => m[2].trim());
    expect(scrolling).toEqual([".nw-phone-drawer__body"]);
    expect(rule(".nw-phone-drawer__body")).toMatch(/flex: 1 1 auto;\s*\n\s*min-height: 0;\s*\n\s*overflow-y: auto;\s*\n\s*overflow-x: hidden;/);
    await recordTwoLegMeetingThenMount();
    await openDrawer();
    expect(q("[data-nw-phone-drawer-header]").contains(body())).toBe(false);
    expect(body().contains(q("[data-nw-phone-drawer-footer]"))).toBe(false);
    expect(body().contains(q("[data-nw-phone-drawer-meetings]"))).toBe(true);
    expect(body().contains(q("[data-nw-phone-drawer-projects]"))).toBe(true);
    // Projects comes after the three groups, in the same flow.
    const children = Array.from(body().children);
    expect(children[children.length - 1]).toBe(q("[data-nw-phone-drawer-projects]"));
  });
});

async function recordTwoLegMeetingThenMount() {
  await mount();
  return recordTwoLegMeeting();
}

describe("6. the three groups collapse independently", () => {
  test("all open by default; each heading is a caret button with aria-expanded that folds only its own items; the state survives closing", async () => {
    await mount({ currentNoteId: "n1", activeProjectId: "p1", activeFolderId: "f1" });
    await openDrawer();
    const groups = [MOBILE_DRAWER_GROUP.THIS_NOTE, MOBILE_DRAWER_GROUP.CAPTURE, MOBILE_DRAWER_GROUP.WORKSPACE];
    for (const group of groups) {
      expect(groupToggle(group).tagName).toBe("BUTTON");
      expect(groupToggle(group).getAttribute("aria-expanded")).toBe("true");
      expect(groupToggle(group).querySelector("svg")).not.toBeNull(); // the caret
      expect(groupItems(group).hidden).toBe(false);
    }
    await click(groupToggle(MOBILE_DRAWER_GROUP.CAPTURE));
    expect(groupToggle(MOBILE_DRAWER_GROUP.CAPTURE).getAttribute("aria-expanded")).toBe("false");
    expect(groupItems(MOBILE_DRAWER_GROUP.CAPTURE).hidden).toBe(true);
    expect(groupItems(MOBILE_DRAWER_GROUP.THIS_NOTE).hidden).toBe(false);
    expect(groupItems(MOBILE_DRAWER_GROUP.WORKSPACE).hidden).toBe(false);
    // Projects is not a collapsible group and stays visible.
    expect(q("[data-nw-phone-drawer-projects]")).not.toBeNull();
    // A heading never navigates and never closes the drawer.
    expect(drawer()).not.toBeNull();
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
    await click(q("[data-nw-phone-drawer-close]"));
    await openDrawer();
    expect(groupItems(MOBILE_DRAWER_GROUP.CAPTURE).hidden).toBe(true);
    expect(groupItems(MOBILE_DRAWER_GROUP.WORKSPACE).hidden).toBe(false);
  });
});

/* ================================ 7–10 ==================================== */

describe("7–10. the project tree is the application state's, and navigation is the shell's", () => {
  test("7. projects, folders, root folders and notes come from the application state; create, rename and delete call its own operations", async () => {
    await mount();
    await openDrawer();
    expect(node("note", "rn1").textContent).toMatch(/Scratch/);
    expect(node("folder", "rf1").textContent).toMatch(/Personal/);
    expect(node("project", "p1").textContent).toMatch(/Harbour Bridge/);
    await click(node("project", "p1"));
    expect(node("project", "p1").getAttribute("aria-expanded")).toBe("true");
    await click(node("folder", "f1"));
    expect(node("note", "n1")).not.toBeNull();
    expect(node("note", "n2")).not.toBeNull();
    await click(node("folder", "rf1"));
    expect(node("note", "rfn1")).not.toBeNull();

    await click(q('[data-nw-phone-drawer-create="project"]'));
    await click(q('[data-nw-phone-drawer-create="folder"]'));
    await click(q('[data-nw-phone-drawer-create="folder-in-project"]'));
    expect(actions.createProject).toHaveBeenCalledTimes(1);
    expect(actions.createRootFolder).toHaveBeenCalledTimes(1);
    expect(actions.createFolder).toHaveBeenCalledWith("p1");
    const inFolder = qa('[data-nw-phone-drawer-create="note-in-folder"]');
    await click(inFolder[0]);
    expect(actions.addNoteToRootFolder.mock.calls.length + actions.addNoteToFolder.mock.calls.length).toBe(1);

    await click(actionsToggle("note", "n2"));
    expect(actionsToggle("note", "n2").getAttribute("aria-expanded")).toBe("true");
    await click(actionIn("note", "n2", "Rename"));
    expect(actions.renameNote).toHaveBeenCalledWith("f1", "n2");
    await click(actionsToggle("note", "rn1"));
    await click(actionIn("note", "rn1", "Delete"));
    expect(actions.deleteRootNote).toHaveBeenCalledWith("rn1");
    await click(actionsToggle("folder", "f1"));
    await click(actionIn("folder", "f1", "Delete"));
    expect(actions.deleteFolder).toHaveBeenCalledWith("p1", "f1");
    await click(actionsToggle("project", "p1"));
    await click(actionIn("project", "p1", "Rename"));
    expect(actions.renameProject).toHaveBeenCalledWith("p1");
    // None of that navigated or closed the drawer.
    expect(drawer()).not.toBeNull();
  });

  test("8/9. choosing a note opens THAT note through the shell's openNote (selection committed) and closes the drawer", async () => {
    await mount();
    await openDrawer();
    await click(node("project", "p1"));
    await click(node("folder", "f1"));
    await click(node("note", "n2"));
    expect(app.current.currentNoteId).toBe("n2");
    expect(app.current.activeProjectId).toBe("p1");
    expect(app.current.activeFolderId).toBe("f1");
    expect(drawer()).toBeNull();
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
    // Focus lands on the ☰ of the screen now showing.
    expect(document.activeElement).toBe(visibleTrigger());
    // The Projects drill-down follows the same selection — one navigation state.
    await click(tab(MOBILE_TAB.PROJECTS));
    expect(q('[data-nw-phone-browse="folder"]')).not.toBeNull();
    // Reopened, the tree shows the open note expanded and marked.
    await openDrawer();
    expect(node("note", "n2").getAttribute("aria-current")).toBe("page");
  });

  test("a note created from the drawer is shown, and the drawer closes", async () => {
    await mount();
    await openDrawer();
    await click(q('[data-nw-phone-drawer-create="note"]'));
    expect(actions.createRootNote).toHaveBeenCalledTimes(1);
    expect(app.current.currentNoteId).toBe("rn-new");
    expect(drawer()).toBeNull();
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
  });

  test("10. the unsent Quick Add draft and the mounted note workspace survive opening, closing and navigating with the drawer", async () => {
    await mount({ currentNoteId: "n1", activeProjectId: "p1", activeFolderId: "f1" });
    await type(composer(), "unsent site note");
    await openDrawer();
    expect(composer().value).toBe("unsent site note");
    await click(q(`[data-nw-phone-drawer-workspace="${MOBILE_TAB.PDFS}"]`));
    expect(visible()).toEqual([MOBILE_TAB.PDFS]);
    await openDrawer();
    await click(q('[data-nw-phone-drawer-note-view="freeform"]'));
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
    expect(composer().value).toBe("unsent site note");
    expect(global.__drawerMainAreaMounts).toBe(1);
  });

  test("THIS NOTE switches the open note's view and opens its linked PDF in the phone viewer; Settings and Template Library open the App's dialogs", async () => {
    await mount({ currentNoteId: "n1", activeProjectId: "p1", activeFolderId: "f1" });
    await openDrawer();
    await click(q('[data-nw-phone-drawer-note-view="template-form"]'));
    expect(app.current.activeNoteView).toBe("template");
    expect(drawer()).toBeNull();
    await openDrawer();
    await click(q('[data-nw-phone-drawer-note-view="pdf"]'));
    expect(visible()).toEqual([MOBILE_TAB.PDFS]);
    expect(q('[data-testid="phone-pdf-viewer"]').getAttribute("data-doc")).toBe("pdf-1");
    await openDrawer();
    await click(q("[data-nw-phone-drawer-settings]"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(drawer()).toBeNull();
    await openDrawer();
    await click(q('[data-nw-phone-drawer-workspace="template-library"]'));
    expect(onOpenTemplateLibrary).toHaveBeenCalledTimes(1);
    expect(drawer()).toBeNull();
  });
});

/* =============================== 11–16 ==================================== */

describe("11–16. Listen In history: the same meetings, the same actions", () => {
  test("11/12. the drawer lists the engine's meetings — ONE entry for a meeting with two recording legs", async () => {
    const id = await recordTwoLegMeetingThenMount();
    expect(engine.getSnapshot().meetings.map((m) => m.sessionId)).toEqual([id]);
    await openDrawer();
    expect(drawerMeetings().map((b) => b.getAttribute("data-nw-phone-drawer-meeting"))).toEqual([id]);
    expect(q("[data-nw-phone-drawer-meetings]").getAttribute("aria-label")).toBe("Saved meetings on this device");
  });

  test("13. a completed meeting opens in the Listen In screen — reviewed, never resumed, no microphone", async () => {
    const id = await recordTwoLegMeetingThenMount();
    await click(listenIn("clear"));
    expect(engine.getSnapshot().session).toBeNull();
    await click(tab(MOBILE_TAB.PROJECTS));
    const calls = getUserMedia.mock.calls.length;
    await openDrawer();
    await click(meetingRow(id));
    expect(drawer()).toBeNull();
    expect(visible()).toEqual([MOBILE_TAB.LISTEN_IN]);
    expect(engine.getSnapshot().session.sessionId).toBe(id);
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(getUserMedia.mock.calls.length).toBe(calls);
  });

  test("14. Delete meeting… asks first, then deletes through the shared engine", async () => {
    const id = await recordTwoLegMeetingThenMount();
    await click(listenIn("clear"));
    await click(tab(MOBILE_TAB.PROJECTS));
    await openDrawer();
    await click(actionsToggle("meeting", id));
    // Cancel: nothing happens.
    await click(actionIn("meeting", id, "Delete meeting…"));
    expect(window.confirm).toHaveBeenCalledWith(MEETING_DELETE_CONFIRM);
    expect(engine.getSnapshot().meetings).toHaveLength(1);
    expect(meetingRow(id)).not.toBeNull();
    // Confirm: the engine deletes it and the row goes.
    window.confirm.mockImplementation(() => true);
    await click(actionsToggle("meeting", id));
    await click(actionIn("meeting", id, "Delete meeting…"));
    await flush();
    expect(engine.getSnapshot().meetings).toEqual([]);
    expect(meetingRow(id)).toBeNull();
    expect(q('[role="alert"]')).toBeNull();
    // The drawer holds no deletion of its own: it is the shared hook's.
    const source = read("components/mobile/MobileDrawer.js");
    expect(source).toMatch(/useMeetingHistory/);
    expect(source).not.toMatch(/deleteSession|window\.confirm|\.deleteMeeting\(/);
  });

  test("14. a delete that did not happen is shown beside its row, keeps the row, and Try again repeats it", async () => {
    freshActions();
    const meetings = [
      { sessionId: "s-done", state: "finished", title: "Listen In — 18 Oct 2026, 07:30", startedAt: 2 },
      { sessionId: "s-other", state: "finished", title: "Site walk", startedAt: 1 },
    ];
    const deleteMeeting = jest
      .fn()
      .mockImplementationOnce(async () => ({ meetings, error: { message: LISTEN_IN_MESSAGE.DELETE_FAILED } }))
      .mockImplementationOnce(async (id) => ({ meetings: meetings.filter((m) => m.sessionId !== id), error: null }));
    const session = { meetings, session: null, open: false, active: false, viewMeeting: jest.fn(), openWorkspace: jest.fn(), deleteMeeting };
    window.confirm.mockImplementation(() => true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
    await act(async () => {
      root.render(
        <AppStateContext.Provider value={{ state: TREE, rootNotes: ROOT_NOTES, ...actions }}>
          <LiveTranscriptContext.Provider value={session}>
            <MobileDrawer onClose={jest.fn()} />
          </LiveTranscriptContext.Provider>
        </AppStateContext.Provider>
      );
    });
    expect(meetingRow("s-done").textContent).toMatch(/18 Oct 2026, 07:30/);
    await click(actionsToggle("meeting", "s-done"));
    await click(actionIn("meeting", "s-done", "Delete meeting…"));
    const alert = q('[data-nw-phone-drawer-meeting-error="s-done"]');
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(LISTEN_IN_MESSAGE.DELETE_FAILED);
    expect(meetingRow("s-done")).not.toBeNull();
    expect(meetingRow("s-other")).not.toBeNull();
    const retry = Array.from(alert.querySelectorAll("button")).find((b) => b.textContent === "Try again");
    await click(retry);
    expect(deleteMeeting.mock.calls).toEqual([["s-done"], ["s-done"]]);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(q('[data-nw-phone-drawer-meeting-error="s-done"]')).toBeNull();
    expect(session.viewMeeting).not.toHaveBeenCalled();
  });

  test.each([
    ["recording", { recording: true }, "Recording"],
    ["paused", { paused: true }, "Stopped"],
    ["interrupted", { interrupted: true }, "Interrupted"],
    ["finishing", { finishing: true }, "Completing"],
  ])("15. %s: saved meetings in the drawer are disabled and cannot view, open or replace the unfinished one", async (state, flags, word) => {
    freshActions();
    const meetings = [
      { sessionId: "s-open", state, title: "Open one", startedAt: 3 },
      { sessionId: "s-done", state: "finished", title: "Done one", startedAt: 2 },
      { sessionId: "s-other", state: "finished", title: "Other one", startedAt: 1 },
    ];
    const live = {
      meetings,
      session: { sessionId: "s-open", state },
      open: false,
      active: true,
      ...flags,
      viewMeeting: jest.fn(),
      openWorkspace: jest.fn(),
      deleteMeeting: jest.fn(),
      discard: jest.fn(),
      clear: jest.fn(),
    };
    const onClose = jest.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
    await act(async () => {
      root.render(
        <AppStateContext.Provider value={{ state: TREE, rootNotes: ROOT_NOTES, ...actions }}>
          <LiveTranscriptContext.Provider value={live}>
            <MobileDrawer onClose={onClose} />
          </LiveTranscriptContext.Provider>
        </AppStateContext.Provider>
      );
    });
    for (const id of ["s-done", "s-other"]) {
      expect(meetingRow(id).disabled).toBe(true);
      await click(meetingRow(id));
    }
    expect(live.viewMeeting).not.toHaveBeenCalled();
    expect(live.openWorkspace).not.toHaveBeenCalled();
    expect(live.discard).not.toHaveBeenCalled();
    expect(live.clear).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(meetingRow("s-open").disabled).toBe(false);
    expect(meetingRow("s-open").getAttribute("aria-label")).toBe(`Open one — ${word}`);
    expect(actionsToggle("meeting", "s-open")).toBeNull();
  });

  test("15. a live recording is untouched by tapping a saved meeting in the drawer (real engine)", async () => {
    const done = await recordTwoLegMeetingThenMount();
    await click(listenIn("clear"));
    await click(listenIn("record")); // a new meeting, recording
    const live = engine.getSnapshot();
    expect(live.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    const mic = getUserMedia.mock.calls.length;
    await click(tab(MOBILE_TAB.PROJECTS));
    await openDrawer();
    await click(meetingRow(done));
    expect(engine.getSnapshot().session.sessionId).toBe(live.session.sessionId);
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(getUserMedia.mock.calls.length).toBe(mic);
    expect(drawer()).not.toBeNull();
  });

  test("15. an unfinished meeting offers no delete, and other meetings cannot displace it", async () => {
    const done = await recordTwoLegMeetingThenMount();
    await click(listenIn("clear"));
    await click(listenIn("record")); // a new meeting
    await click(listenIn("record")); // Stop recording — unfinished
    const open = engine.getSnapshot().session.sessionId;
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.PAUSED);
    await click(tab(MOBILE_TAB.PROJECTS));
    await openDrawer();
    expect(actionsToggle("meeting", open)).toBeNull();
    expect(meetingRow(open).getAttribute("aria-label")).toMatch(/Stopped/);
    expect(meetingRow(done).disabled).toBe(true);
    // The engine refuses it too, whoever asks.
    const snap = await act(async () => engine.deleteMeeting(open));
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.DELETE_UNFINISHED);
    expect(engine.getSnapshot().session.sessionId).toBe(open);
  });

  test("16/17. the mini-bar keeps showing a live recording while the drawer is open; the bottom navigation works once it closes", async () => {
    await mount();
    await click(tab(MOBILE_TAB.LISTEN_IN));
    await click(listenIn("record"));
    await click(tab(MOBILE_TAB.PROJECTS));
    expect(miniBar().getAttribute("data-listen-in-mini-bar")).toBe("recording");
    await openDrawer();
    expect(miniBar().getAttribute("data-listen-in-mini-bar")).toBe("recording");
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    // Folded away, CAPTURE still marks the live meeting.
    await click(groupToggle(MOBILE_DRAWER_GROUP.CAPTURE));
    expect(q("[data-nw-phone-drawer-capture-indicator]")).not.toBeNull();
    expect(groupToggle(MOBILE_DRAWER_GROUP.CAPTURE).textContent).toMatch(/recording/);
    await key(document, "Escape");
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(miniBar().getAttribute("data-listen-in-mini-bar")).toBe("recording");
    await click(tab(MOBILE_TAB.PDFS));
    expect(visible()).toEqual([MOBILE_TAB.PDFS]);
    await click(tab(MOBILE_TAB.MORE));
    expect(visible()).toEqual([MOBILE_TAB.MORE]);
  });
});

/* ================================= 18 ===================================== */

describe("18. the desktop sidebar is not part of this", () => {
  test("the drawer is not the desktop Sidebar, and the desktop Sidebar knows nothing of the drawer", () => {
    const drawerSource = read("components/mobile/MobileDrawer.js");
    expect(drawerSource).not.toMatch(/from "\.\.\/Sidebar"/);
    const sidebar = read("components/Sidebar.js");
    expect(sidebar).not.toMatch(/MobileDrawer|PhoneDrawerContext|mobile\//);
    // Both read the meeting history through the one shared hook.
    expect(sidebar).toMatch(/useMeetingHistory\(liveTranscript\)/);
    expect(drawerSource).toMatch(/useMeetingHistory\(listenIn\)/);
  });
});
