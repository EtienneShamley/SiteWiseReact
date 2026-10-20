// src/components/SidebarMeetingDelete.test.js
//
// DELETE MEETING in the desktop sidebar's CAPTURE history (2026-10-21): a
// discreet ⋮ beside each COMPLETED saved meeting, the existing ThreeDotMenu
// with one destructive row, and the app's existing explicit confirmation
// before anything is deleted. Unfinished meetings get no menu (Complete or
// Discard them in Listen In). The deletion itself is the engine's
// (src/lib/listenIn/listenInMeetingDelete.test.js); here the sidebar is proved
// to ask first and to name exactly one meeting.
//
// The real Sidebar mounted in jsdom over the smallest app state it reads, as
// in SidebarOneScroll.test.js.

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import Sidebar from "./Sidebar";
import { AppStateContext } from "../context/AppStateContext";
import { LISTEN_IN_MESSAGE, MEETING_DELETE_CONFIRM } from "../lib/listenIn/listenInModel";

jest.mock("../context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
let mockLiveTranscript = null;
jest.mock("../context/LiveTranscriptContext", () => ({
  useLiveTranscriptSession: () => mockLiveTranscript,
}));
jest.mock("./ShareDialog", () => () => null);
jest.mock("./MoveNoteDialog", () => () => null);

global.IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_760_000_000_000;

function appState() {
  return {
    rootNotes: [],
    createRootNote: jest.fn(),
    renameRootNote: jest.fn(),
    deleteRootNote: jest.fn(),
    state: { projectData: [{ id: "p1", name: "Project One" }], folderMap: { p1: [] }, rootFolders: [], rootFolderNotesMap: {} },
    activeProjectId: null,
    activeFolderId: null,
    expandedProjectId: null,
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
    currentNoteId: null,
    activeNoteView: "natural",
    setActiveNoteView: jest.fn(),
    noteWorkspaceTab: "note",
    setNoteWorkspaceTab: jest.fn(),
  };
}

const meeting = (sessionId, state, title, hoursAgo = 0) => ({ sessionId, state, title, startedAt: T0 - hoursAgo * 3600 * 1000 });

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
    deleteMeeting: jest.fn(async () => null),
    discard: jest.fn(),
    clear: jest.fn(),
    ...overrides,
  };
}

let container;
let root;

function render(props = {}) {
  // eslint-disable-next-line testing-library/no-unnecessary-act -- false positive: `root.render` is react-dom/client's, not Testing Library's (not a dependency here); React requires act() for it under IS_REACT_ACT_ENVIRONMENT.
  act(() => {
    root.render(
      <AppStateContext.Provider value={appState()}>
        <Sidebar onOpenTemplateLibrary={jest.fn()} onOpenSettings={jest.fn()} onToggleCollapsed={jest.fn()} {...props} />
      </AppStateContext.Provider>
    );
  });
}

const $ = (selector) => document.querySelector(selector);
const menuButton = (id) => container.querySelector(`[data-nw-listen-in-meeting-menu="${id}"]`);
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const clickAsync = async (el) => {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const alertFor = (id) => container.querySelector(`[data-nw-listen-in-meeting-error="${id}"]`);
const rowFor = (id) => container.querySelector(`[data-nw-listen-in-meeting="${id}"]`);
const buttonIn = (el, text) => Array.from(el.querySelectorAll("button")).find((b) => b.textContent.trim() === text);
/** The engine's answers: the snapshot after a delete that worked, or did not. */
const deleted = (id) => ({ meetings: HISTORY.filter((m) => m.sessionId !== id), error: null });
const notDeleted = (message = LISTEN_IN_MESSAGE.DELETE_FAILED) => ({ meetings: HISTORY, error: { message } });
async function confirmDelete(id) {
  click(menuButton(id));
  await clickAsync(menuItems()[0]);
}
const menuItems = () => Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'));

const HISTORY = [
  meeting("s-done", "finished", "Listen In — 18 Oct 2026, 07:30", 2),
  meeting("s-other", "finished", "Site walk", 5),
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  jest.spyOn(window, "confirm").mockImplementation(() => false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

describe("6. each completed meeting has an accessible ⋮ menu", () => {
  test("a labelled menu button per completed row; it opens the shared menu with one destructive Delete meeting… row", () => {
    mockLiveTranscript = session({ meetings: HISTORY });
    render();
    const button = menuButton("s-done");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Actions for 18 Oct 2026, 07:30");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(menuButton("s-other").getAttribute("aria-label")).toBe("Actions for Site walk");
    // A sibling of the row button, never nested inside it.
    expect(button.closest("[data-nw-listen-in-meeting]")).toBeNull();
    expect(button.parentElement).toBe(container.querySelector('[data-nw-listen-in-meeting="s-done"]').parentElement);

    click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menuItems().map((item) => item.textContent.trim())).toEqual(["Delete meeting…"]);
    // Opening the menu neither views, opens nor deletes the meeting.
    expect(mockLiveTranscript.viewMeeting).not.toHaveBeenCalled();
    expect(mockLiveTranscript.openWorkspace).not.toHaveBeenCalled();
    expect(mockLiveTranscript.deleteMeeting).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  test("unfinished meetings get no menu — Complete or Discard them in Listen In", () => {
    mockLiveTranscript = session({
      active: true,
      paused: true,
      session: { sessionId: "s-open", state: "paused" },
      meetings: [
        meeting("s-open", "paused", "Stopped one", 0),
        meeting("s-rec", "recording", "Recording one", 1),
        meeting("s-int", "interrupted", "Interrupted one", 3),
        meeting("s-fin", "finishing", "Completing one", 4),
        ...HISTORY,
      ],
    });
    render();
    for (const id of ["s-open", "s-rec", "s-int", "s-fin"]) expect(menuButton(id)).toBeNull();
    // Completed rows keep their menu while a meeting is active (their row
    // button is disabled — it cannot displace the active meeting — but
    // deleting a different, completed meeting touches nothing of it).
    expect(container.querySelector('[data-nw-listen-in-meeting="s-done"]').disabled).toBe(true);
    expect(menuButton("s-done")).not.toBeNull();
  });

  test("the collapsed icon rail shows no history and no menus", () => {
    mockLiveTranscript = session({ meetings: HISTORY });
    render({ collapsed: true });
    expect(container.querySelector("[data-nw-listen-in-meeting-menu]")).toBeNull();
  });
});

describe("7/8. nothing is deleted without an explicit confirmation", () => {
  test("7. Cancel deletes nothing and changes nothing", () => {
    mockLiveTranscript = session({ meetings: HISTORY });
    render();
    click(menuButton("s-done"));
    click(menuItems()[0]);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(MEETING_DELETE_CONFIRM);
    expect(mockLiveTranscript.deleteMeeting).not.toHaveBeenCalled();
    expect(mockLiveTranscript.discard).not.toHaveBeenCalled();
    expect(mockLiveTranscript.clear).not.toHaveBeenCalled();
    expect($('[role="menu"]')).toBeNull();
    expect(container.querySelectorAll("[data-nw-listen-in-meeting]")).toHaveLength(2);
  });

  test("8. confirming deletes exactly that one meeting — through the history delete, never Discard or Clear — and claims nothing", async () => {
    window.confirm.mockImplementation(() => true);
    mockLiveTranscript = session({ meetings: HISTORY, deleteMeeting: jest.fn(async (id) => deleted(id)) });
    render();
    await confirmDelete("s-other");
    expect(window.confirm).toHaveBeenCalledWith(MEETING_DELETE_CONFIRM);
    expect(mockLiveTranscript.deleteMeeting).toHaveBeenCalledTimes(1);
    expect(mockLiveTranscript.deleteMeeting).toHaveBeenCalledWith("s-other");
    expect(mockLiveTranscript.discard).not.toHaveBeenCalled();
    expect(mockLiveTranscript.clear).not.toHaveBeenCalled();
    expect(mockLiveTranscript.viewMeeting).not.toHaveBeenCalled();
    // Success shows no message at all — the row leaving the engine's list is
    // the only signal, so no remote deletion is ever announced as done.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("the confirmation names the loss and that it is permanent", () => {
    expect(MEETING_DELETE_CONFIRM).toMatch(/^Delete this meeting\?/);
    expect(MEETING_DELETE_CONFIRM).toMatch(/saved transcript and summary will also be deleted/);
    expect(MEETING_DELETE_CONFIRM).toMatch(/cannot be undone/);
  });
});

describe("a failed delete is reported where it was asked for, and can be retried", () => {
  test("the engine's refusal is shown beside that row, the row stays, and the other meeting is untouched", async () => {
    window.confirm.mockImplementation(() => true);
    mockLiveTranscript = session({ meetings: HISTORY, deleteMeeting: jest.fn(async () => notDeleted()) });
    render();
    await confirmDelete("s-done");
    const alert = alertFor("s-done");
    expect(alert).not.toBeNull();
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(LISTEN_IN_MESSAGE.DELETE_FAILED);
    expect(LISTEN_IN_MESSAGE.DELETE_FAILED).toMatch(/could not be deleted/);
    expect(LISTEN_IN_MESSAGE.DELETE_FAILED).not.toMatch(/\bdeleted from|removed from|account/i);
    // Retained, still deletable, and the only alert on the list.
    expect(rowFor("s-done")).not.toBeNull();
    expect(menuButton("s-done")).not.toBeNull();
    expect(alertFor("s-other")).toBeNull();
    expect(rowFor("s-other")).not.toBeNull();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  test("a rejected or engine-less delete is a failure too, never a silent success", async () => {
    window.confirm.mockImplementation(() => true);
    mockLiveTranscript = session({ meetings: HISTORY, deleteMeeting: jest.fn(async () => { throw new Error("boom"); }) });
    render();
    await confirmDelete("s-done");
    expect(alertFor("s-done").textContent).toContain(LISTEN_IN_MESSAGE.DELETE_FAILED);

    mockLiveTranscript = session({ meetings: HISTORY, deleteMeeting: jest.fn(() => null) });
    render();
    await confirmDelete("s-other");
    expect(alertFor("s-other").textContent).toContain(LISTEN_IN_MESSAGE.DELETE_FAILED);
  });

  test("Try again re-runs the confirmed delete for that meeting; on success the message goes", async () => {
    window.confirm.mockImplementation(() => true);
    const deleteMeeting = jest
      .fn()
      .mockImplementationOnce(async () => notDeleted())
      .mockImplementationOnce(async (id) => deleted(id));
    mockLiveTranscript = session({ meetings: HISTORY, deleteMeeting });
    render();
    await confirmDelete("s-done");
    await clickAsync(buttonIn(alertFor("s-done"), "Try again"));
    expect(deleteMeeting.mock.calls).toEqual([["s-done"], ["s-done"]]);
    // Asked once: the retry repeats the delete the user already confirmed.
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(alertFor("s-done")).toBeNull();
    expect(mockLiveTranscript.discard).not.toHaveBeenCalled();
    expect(mockLiveTranscript.clear).not.toHaveBeenCalled();
  });

  test("a retry that fails again keeps saying so; Dismiss only hides the message", async () => {
    window.confirm.mockImplementation(() => true);
    const deleteMeeting = jest.fn(async () => notDeleted());
    mockLiveTranscript = session({ meetings: HISTORY, deleteMeeting });
    render();
    await confirmDelete("s-done");
    await clickAsync(buttonIn(alertFor("s-done"), "Try again"));
    expect(deleteMeeting).toHaveBeenCalledTimes(2);
    expect(alertFor("s-done")).not.toBeNull();
    click(buttonIn(alertFor("s-done"), "Dismiss"));
    expect(alertFor("s-done")).toBeNull();
    expect(deleteMeeting).toHaveBeenCalledTimes(2);
    expect(rowFor("s-done")).not.toBeNull();
  });

  test("the engine's own refusal wording is the one shown", async () => {
    window.confirm.mockImplementation(() => true);
    mockLiveTranscript = session({ meetings: HISTORY, deleteMeeting: jest.fn(async () => notDeleted(LISTEN_IN_MESSAGE.DELETE_UNFINISHED)) });
    render();
    await confirmDelete("s-done");
    expect(alertFor("s-done").textContent).toContain(LISTEN_IN_MESSAGE.DELETE_UNFINISHED);
  });
});

describe("selecting a saved meeting never displaces an unfinished one (desktop CAPTURE)", () => {
  const STATES = [
    ["recording", { recording: true }, "Recording"],
    ["paused", { paused: true }, "Stopped"],
    ["interrupted", { interrupted: true }, "Interrupted"],
    ["finishing", { finishing: true }, "Completing"],
  ];
  test.each(STATES)("%s: the saved rows are disabled, tapping one views and opens nothing, and the unfinished row stays", async (state, flags, word) => {
    mockLiveTranscript = session({
      active: true,
      ...flags,
      session: { sessionId: "s-open", state },
      meetings: [meeting("s-open", state, "Open one", 0), ...HISTORY],
    });
    render();
    for (const id of ["s-done", "s-other"]) {
      const row = rowFor(id);
      expect(row.disabled).toBe(true);
      expect(row.getAttribute("title")).toMatch(/complete the current meeting to open this one/);
      await clickAsync(row);
    }
    expect(mockLiveTranscript.viewMeeting).not.toHaveBeenCalled();
    expect(mockLiveTranscript.openWorkspace).not.toHaveBeenCalled();
    expect(mockLiveTranscript.discard).not.toHaveBeenCalled();
    expect(mockLiveTranscript.clear).not.toHaveBeenCalled();
    // The unfinished meeting is enabled, says what it is, and has no delete.
    const open = rowFor("s-open");
    expect(open.disabled).toBe(false);
    expect(open.getAttribute("aria-label")).toBe(`Open one — ${word}`);
    expect(menuButton("s-open")).toBeNull();
  });

  test("the unfinished meeting itself opens without re-viewing it", async () => {
    mockLiveTranscript = session({
      active: true,
      paused: true,
      session: { sessionId: "s-open", state: "paused" },
      meetings: [meeting("s-open", "paused", "Open one", 0), ...HISTORY],
    });
    render();
    await clickAsync(rowFor("s-open"));
    expect(mockLiveTranscript.viewMeeting).not.toHaveBeenCalled();
    expect(mockLiveTranscript.openWorkspace).toHaveBeenCalledTimes(1);
  });
});
