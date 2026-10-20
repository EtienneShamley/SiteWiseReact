// src/components/SidebarOneScroll.test.js
//
// Desktop sidebar, co-founder feedback revision (2026-10-20): ONE scrolling
// body (like a chat app's conversation list) between the header and the
// footer, holding the THIS NOTE / CAPTURE / WORKSPACE groups — each
// collapsible on its own — and the Projects tree in plain flow, with no
// scroll region of its own. CAPTURE lists the account's saved Listen In
// meetings under Listen In.
//
// The real Sidebar mounted in jsdom. Layout ownership (which jsdom cannot
// compute) is asserted on the rendered class lists; behaviour by clicking.
// The phone shell never renders this Sidebar and is checked for that.

import React from "react";
import fs from "fs";
import path from "path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Sidebar, { SIDEBAR_GROUP } from "./Sidebar";
import { AppStateContext } from "../context/AppStateContext";

jest.mock("../context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
let mockLiveTranscript = null;
jest.mock("../context/LiveTranscriptContext", () => ({
  useLiveTranscriptSession: () => mockLiveTranscript,
}));
jest.mock("./ShareDialog", () => () => null);
jest.mock("./MoveNoteDialog", () => () => null);

global.IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_760_000_000_000;

function appState(overrides = {}) {
  return {
    rootNotes: [{ id: "rn1", title: "Loose note" }],
    createRootNote: jest.fn(),
    renameRootNote: jest.fn(),
    deleteRootNote: jest.fn(),
    state: {
      projectData: [{ id: "p1", name: "Project One" }],
      folderMap: { p1: [{ id: "f1", name: "Site visits", notes: [{ id: "n1", title: "Visit 1" }] }] },
      rootFolders: [{ id: "rf1", name: "Inbox" }],
      rootFolderNotesMap: {},
    },
    activeProjectId: "p1",
    activeFolderId: null,
    expandedProjectId: "p1",
    setExpandedProjectId: jest.fn(),
    setActiveSelection: jest.fn(),
    clearActiveSelection: jest.fn(),
    setCurrentNoteId: jest.fn(),
    noteDrag: null,
    beginNoteDrag: jest.fn(),
    endNoteDrag: jest.fn(),
    moveNote: jest.fn(),
    createProject: jest.fn(),
    renameProject: jest.fn(),
    deleteProject: jest.fn(),
    createFolder: jest.fn(),
    renameFolder: jest.fn(),
    deleteFolder: jest.fn(),
    createRootFolder: jest.fn(),
    renameRootFolder: jest.fn(),
    deleteRootFolder: jest.fn(),
    workspace: "projects",
    setWorkspace: jest.fn(),
    currentNoteId: "n1",
    activeNoteView: "natural",
    setActiveNoteView: jest.fn(),
    noteWorkspaceTab: "note",
    setNoteWorkspaceTab: jest.fn(),
    ...overrides,
  };
}

const meeting = (sessionId, state, title, hoursAgo = 0) => ({
  sessionId,
  state,
  title,
  startedAt: T0 - hoursAgo * 3600 * 1000,
});

function session(overrides = {}) {
  return {
    open: false,
    recording: false,
    finishing: false,
    paused: false,
    interrupted: false,
    active: false,
    limitWarned: false,
    session: null,
    meetings: [],
    openWorkspace: jest.fn(),
    viewMeeting: jest.fn(async () => null),
    ...overrides,
  };
}

let container;
let root;

function render(value, props = {}) {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  act(() => {
    root.render(
      <AppStateContext.Provider value={value}>
        <Sidebar onOpenTemplateLibrary={jest.fn()} onOpenSettings={jest.fn()} onToggleCollapsed={jest.fn()} {...props} />
      </AppStateContext.Provider>
    );
  });
}

const $ = (selector) => container.querySelector(selector);
const toggle = (group) => $(`[data-nw-sidebar-group-toggle="${group}"]`);
const itemsOf = (group) => document.getElementById(toggle(group).getAttribute("aria-controls"));
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const clickAsync = async (el) => {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const buttonByText = (text) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent.trim() === text);
const classesOf = (el) => el.className.split(/\s+/);
const scrollers = () =>
  Array.from(container.querySelectorAll("[class]")).filter((el) =>
    /(^|\s)overflow-(y-)?(auto|scroll)(\s|$)/.test(el.className)
  );

beforeEach(() => {
  mockLiveTranscript = session();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("1/2. ONE vertical scroll owner; the Projects tree has none of its own", () => {
  test("the body between header and footer is the only scroller, and it holds the groups AND the tree", () => {
    render(appState());
    const body = $("[data-nw-sidebar-body]");
    expect(scrollers()).toEqual([body]);
    expect(classesOf(body)).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "overflow-y-auto"]));
    expect(body.parentElement.id).toBe("leftPane");
    for (const group of Object.values(SIDEBAR_GROUP)) expect(body.contains(toggle(group))).toBe(true);
    const projects = $("[data-nw-projects]");
    expect(body.contains(projects)).toBe(true);
    expect(projects.className).not.toMatch(/overflow|max-h-|flex-1/);
    expect($("#leftPane").innerHTML).not.toMatch(/max-h-/);
  });

  test("the header precedes the body and the footer follows it as the aside's last block", () => {
    render(appState());
    const body = $("[data-nw-sidebar-body]");
    const footer = $("#leftPane").lastElementChild;
    expect(footer.hasAttribute("data-nw-sidebar-footer")).toBe(true);
    expect(footer.previousElementSibling).toBe(body);
    expect(classesOf(footer)).toContain("shrink-0");
    expect(body.previousElementSibling.textContent).toContain("NoteWise");
  });
});

describe("3–7. THIS NOTE, CAPTURE and WORKSPACE collapse independently and never navigate", () => {
  test.each([
    [SIDEBAR_GROUP.THIS_NOTE, "This note", ["Template form", "Free-form note", "PDF"]],
    [SIDEBAR_GROUP.CAPTURE, "Capture", ["Listen In"]],
    [SIDEBAR_GROUP.WORKSPACE, "Workspace", ["Projects", "PDFs", "Template Library"]],
  ])("%s: open by default, a disclosure button over its own items", (group, label, items) => {
    render(appState());
    const heading = toggle(group);
    expect(heading.tagName).toBe("BUTTON");
    expect(heading.textContent).toContain(label);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(heading.querySelector("svg")).not.toBeNull();
    for (const item of items) expect(itemsOf(group).textContent).toContain(item);
    expect(itemsOf(group).hidden).toBe(false);
    click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(itemsOf(group).hidden).toBe(true);
    for (const item of items) expect(itemsOf(group).textContent).toContain(item);
    click(heading);
    expect(itemsOf(group).hidden).toBe(false);
  });

  test("groups are independent — several may be open or closed at once", () => {
    render(appState());
    click(toggle(SIDEBAR_GROUP.THIS_NOTE));
    click(toggle(SIDEBAR_GROUP.WORKSPACE));
    expect(itemsOf(SIDEBAR_GROUP.THIS_NOTE).hidden).toBe(true);
    expect(itemsOf(SIDEBAR_GROUP.CAPTURE).hidden).toBe(false);
    expect(itemsOf(SIDEBAR_GROUP.WORKSPACE).hidden).toBe(true);
  });

  test("a heading click navigates nowhere and touches no app or Listen In state", () => {
    const value = appState();
    render(value);
    for (const group of Object.values(SIDEBAR_GROUP)) click(toggle(group));
    for (const fn of [value.setWorkspace, value.setCurrentNoteId, value.setActiveSelection, value.setActiveNoteView, value.setNoteWorkspaceTab]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(mockLiveTranscript.openWorkspace).not.toHaveBeenCalled();
    expect(mockLiveTranscript.viewMeeting).not.toHaveBeenCalled();
  });

  test("the open state survives re-renders and navigation while mounted", () => {
    const value = appState();
    render(value);
    click(toggle(SIDEBAR_GROUP.CAPTURE));
    render({ ...value, workspace: "pdfs", currentNoteId: null });
    render(value);
    expect(toggle(SIDEBAR_GROUP.CAPTURE).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("8–10. Projects is directly visible, in flow, with every existing control", () => {
  test.each([
    ["a note open", {}],
    ["no note", { currentNoteId: null }],
    ["the PDFs workspace", { workspace: "pdfs" }],
  ])("visible with %s", (_label, overrides) => {
    render(appState(overrides));
    expect($("[data-nw-projects]").textContent).toContain("Project One");
  });

  test("root-level notes, root folders and projects follow each other in the body's flow", () => {
    render(appState());
    const text = $("[data-nw-projects]").textContent;
    const at = (s) => text.indexOf(s);
    expect(at("Projects")).toBeGreaterThan(-1);
    expect(at("+ New Project")).toBeGreaterThan(at("Projects"));
    expect(at("Loose note")).toBeGreaterThan(at("+ New Note"));
    expect(at("Inbox")).toBeGreaterThan(at("Loose note"));
    expect(at("Project One")).toBeGreaterThan(at("Inbox"));
    expect(at("Site visits")).toBeGreaterThan(at("Project One"));
  });

  test("create actions, tree rows and three-dot triggers still work", () => {
    const value = appState();
    render(value);
    click(buttonByText("+ New Project"));
    click(buttonByText("+ New Note"));
    expect(value.createProject).toHaveBeenCalledTimes(1);
    expect(value.createRootNote).toHaveBeenCalledTimes(1);
    const loose = Array.from($("[data-nw-projects]").querySelectorAll("span")).find((s) => s.textContent === "Loose note");
    click(loose);
    expect(value.setCurrentNoteId).toHaveBeenCalledWith("rn1");
    expect($("[data-nw-projects]").querySelectorAll("button svg").length).toBeGreaterThan(0);
  });
});

describe("11. the collapsed icon rail is unchanged in what it shows", () => {
  test("no headings, no tree, no meeting list; every item an icon even if folded while expanded", () => {
    mockLiveTranscript = session({ meetings: [meeting("s-1", "finished", "Listen In — 1 Oct 2026, 09:00")] });
    const value = appState();
    render(value);
    for (const group of Object.values(SIDEBAR_GROUP)) click(toggle(group));
    render(value, { collapsed: true });
    expect(container.querySelector("[data-nw-sidebar-group-toggle]")).toBeNull();
    expect($("[data-nw-projects]")).toBeNull();
    expect($("[data-nw-listen-in-meetings]")).toBeNull();
    for (const label of ["Template form", "Free-form note", "PDF", "Projects", "PDFs"]) {
      const item = container.querySelector(`button[aria-label="${label}"]`);
      expect(item).not.toBeNull();
      expect(item.closest("[hidden]")).toBeNull();
    }
    expect($('[data-nw-capture="live-transcript"]').closest("[hidden]")).toBeNull();
    expect($("#leftPane").lastElementChild.hasAttribute("data-nw-sidebar-footer")).toBe(true);
    render(value);
    expect(toggle(SIDEBAR_GROUP.WORKSPACE).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("12. the phone shell does not use this sidebar", () => {
  test("no phone component renders Sidebar or its group/body hooks", () => {
    const dir = path.join(__dirname, "mobile");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      expect(source).not.toMatch(/from "\.\.\/Sidebar"|SIDEBAR_GROUP|data-nw-sidebar-body|data-nw-listen-in-meetings/);
    }
  });
});

describe("13–15. saved Listen In meetings under Listen In", () => {
  test("13. listed under the Listen In row from the session's meetings, labelled without the default prefix", () => {
    mockLiveTranscript = session({
      meetings: [
        meeting("s-2", "finished", "Client discussion", 1),
        meeting("s-1", "finished", "Listen In — 18 Oct 2026, 07:30", 48),
      ],
    });
    render(appState());
    const list = $("[data-nw-listen-in-meetings]");
    expect(itemsOf(SIDEBAR_GROUP.CAPTURE).contains(list)).toBe(true);
    const rows = Array.from(list.querySelectorAll("[data-nw-listen-in-meeting]"));
    expect(rows.map((r) => r.textContent.trim())).toEqual(["Client discussion", "18 Oct 2026, 07:30"]);
    expect(rows[1].getAttribute("title")).toBe("Listen In — 18 Oct 2026, 07:30");
    // Folding CAPTURE folds the list with it.
    click(toggle(SIDEBAR_GROUP.CAPTURE));
    expect(list.closest("[hidden]")).not.toBeNull();
  });

  test("14. choosing a completed meeting views it, then opens the ONE Listen In window", async () => {
    mockLiveTranscript = session({ meetings: [meeting("s-1", "finished", "Site meeting")] });
    render(appState());
    const row = $('[data-nw-listen-in-meeting="s-1"]');
    expect(row.disabled).toBe(false);
    await clickAsync(row);
    expect(mockLiveTranscript.viewMeeting).toHaveBeenCalledWith("s-1");
    expect(mockLiveTranscript.openWorkspace).toHaveBeenCalledWith(row);
  });

  test("15. the unfinished meeting carries its status, opens without re-viewing, and others cannot displace it", async () => {
    mockLiveTranscript = session({
      active: true,
      paused: true,
      session: { sessionId: "s-open", state: "paused" },
      meetings: [meeting("s-open", "paused", "Toolbox talk"), meeting("s-done", "finished", "Site meeting", 5)],
    });
    render(appState());
    const open = $('[data-nw-listen-in-meeting="s-open"]');
    expect(open.textContent).toContain("Stopped");
    expect(open.getAttribute("aria-label")).toBe("Toolbox talk — Stopped");
    await clickAsync(open);
    expect(mockLiveTranscript.viewMeeting).not.toHaveBeenCalled();
    expect(mockLiveTranscript.openWorkspace).toHaveBeenCalledTimes(1);
    const other = $('[data-nw-listen-in-meeting="s-done"]');
    expect(other.disabled).toBe(true);
    expect(other.getAttribute("title")).toMatch(/complete the current meeting/);
  });

  test("the meeting the open window shows is marked current", () => {
    mockLiveTranscript = session({
      open: true,
      session: { sessionId: "s-1", state: "finished" },
      meetings: [meeting("s-1", "finished", "Site meeting")],
    });
    render(appState());
    expect($('[data-nw-listen-in-meeting="s-1"]').getAttribute("aria-current")).toBe("true");
  });

  test("a folded CAPTURE still signals an unfinished meeting on its heading", () => {
    mockLiveTranscript = session({ active: true, recording: true, session: { sessionId: "s", startedAt: T0 } });
    render(appState());
    expect($("[data-nw-capture-group-indicator]")).toBeNull();
    click(toggle(SIDEBAR_GROUP.CAPTURE));
    expect($("[data-nw-capture-group-indicator]")).not.toBeNull();
    expect(toggle(SIDEBAR_GROUP.CAPTURE).textContent).toMatch(/recording/i);
  });

  test("no meetings, no list", () => {
    render(appState());
    expect($("[data-nw-listen-in-meetings]")).toBeNull();
  });
});
