// src/lib/mobileShell.test.js
//
// The phone shell's pure model (Phase 8E.1): the boundary query, the tabs, the
// visible screen, the Listen In mini-bar's state and words for every meeting
// lifecycle state, the Projects drill-down resolution, note location, and the
// keyboard helpers.
import {
  KEYBOARD_OPEN_THRESHOLD_PX,
  LISTEN_IN_MINI_BAR,
  MOBILE_BROWSE_LEVEL,
  MOBILE_TAB,
  MOBILE_TAB_LABEL,
  MOBILE_TAB_ORDER,
  PHONE_SHELL_QUERY,
  browseLevel,
  browseParent,
  browsePathFromSelection,
  initialMobileTab,
  isKeyboardOpen,
  isTextEntryElement,
  keyboardInsetPx,
  listenInMiniBarCopy,
  listenInMiniBarState,
  locateNote,
  resolveBrowse,
  shouldShowListenInMiniBar,
  visibleMobileTab,
} from "./mobileShell";
import { LISTEN_IN_STATE } from "./listenIn/listenInModel";

const TREE = {
  projectData: [{ id: "p1", name: "Harbour Bridge" }],
  folderMap: {
    p1: [{ id: "f1", name: "Site visits", notes: [{ id: "n1", title: "Day 1" }] }],
  },
  rootFolders: [{ id: "rf1", name: "Personal" }],
  rootFolderNotesMap: { rf1: [{ id: "rfn1", title: "Ideas" }] },
  rootNotes: [{ id: "rn1", title: "Scratch" }],
};

/** The adapter snapshot shape (useLiveTranscript), reduced to what the bar reads. */
function adapter(state, over = {}) {
  const session = state ? { sessionId: "s1", state, startedAt: 0, capturedMs: 65000 } : null;
  return {
    session,
    recording: state === LISTEN_IN_STATE.RECORDING || state === LISTEN_IN_STATE.STOPPING,
    paused: state === LISTEN_IN_STATE.PAUSED,
    interrupted: state === LISTEN_IN_STATE.INTERRUPTED,
    completing: state === LISTEN_IN_STATE.STOPPING || state === LISTEN_IN_STATE.FINISHING,
    finishing: state === LISTEN_IN_STATE.FINISHING,
    finished: state === LISTEN_IN_STATE.FINISHED,
    active: !!state && state !== LISTEN_IN_STATE.FINISHED && state !== LISTEN_IN_STATE.IDLE,
    ...over,
  };
}

describe("the shell boundary", () => {
  test("phone-width viewports, and phone-height touch landscape, take the phone shell", () => {
    expect(PHONE_SHELL_QUERY).toBe("(max-width: 767px), (max-height: 500px) and (pointer: coarse)");
  });
});

describe("tabs", () => {
  test("bottom navigation is Projects / Note / Listen In / PDFs / More, each with a text label", () => {
    expect(MOBILE_TAB_ORDER).toEqual(["projects", "note", "listen-in", "pdfs", "more"]);
    expect(MOBILE_TAB_ORDER.map((t) => MOBILE_TAB_LABEL[t])).toEqual([
      "Projects",
      "Note",
      "Listen In",
      "PDFs",
      "More",
    ]);
  });

  test("the shell opens on the note when one is open, otherwise on Projects", () => {
    expect(initialMobileTab({ currentNoteId: "n1" })).toBe(MOBILE_TAB.NOTE);
    expect(initialMobileTab({ currentNoteId: null })).toBe(MOBILE_TAB.PROJECTS);
    expect(initialMobileTab()).toBe(MOBILE_TAB.PROJECTS);
  });

  test("Listen In is visible exactly while the provider says open, and covers the remembered tab", () => {
    expect(visibleMobileTab({ tab: MOBILE_TAB.PDFS, listenInOpen: true })).toBe(MOBILE_TAB.LISTEN_IN);
    expect(visibleMobileTab({ tab: MOBILE_TAB.PDFS, listenInOpen: false })).toBe(MOBILE_TAB.PDFS);
    // A stored Listen In tab or garbage never strands the user on a blank screen.
    expect(visibleMobileTab({ tab: MOBILE_TAB.LISTEN_IN, listenInOpen: false })).toBe(MOBILE_TAB.PROJECTS);
    expect(visibleMobileTab({ tab: "nope" })).toBe(MOBILE_TAB.PROJECTS);
  });
});

describe("the Listen In mini-bar model", () => {
  test("no meeting, and a completed meeting, show no bar", () => {
    expect(listenInMiniBarState(null)).toBeNull();
    expect(listenInMiniBarState(adapter(null))).toBeNull();
    expect(listenInMiniBarState(adapter(LISTEN_IN_STATE.IDLE))).toBeNull();
    expect(listenInMiniBarState(adapter(LISTEN_IN_STATE.FINISHED))).toBeNull();
  });

  test("each unfinished lifecycle state maps to its own representation", () => {
    expect(listenInMiniBarState(adapter(LISTEN_IN_STATE.RECORDING))).toBe(LISTEN_IN_MINI_BAR.RECORDING);
    expect(listenInMiniBarState(adapter(LISTEN_IN_STATE.PAUSED))).toBe(LISTEN_IN_MINI_BAR.STOPPED);
    expect(listenInMiniBarState(adapter(LISTEN_IN_STATE.INTERRUPTED))).toBe(LISTEN_IN_MINI_BAR.INTERRUPTED);
    expect(listenInMiniBarState(adapter(LISTEN_IN_STATE.FINISHING))).toBe(LISTEN_IN_MINI_BAR.COMPLETING);
  });

  test("a meeting sealing its last leg is COMPLETING, even though the adapter still reports recording", () => {
    const sealing = adapter(LISTEN_IN_STATE.STOPPING);
    expect(sealing.recording).toBe(true);
    expect(listenInMiniBarState(sealing)).toBe(LISTEN_IN_MINI_BAR.COMPLETING);
  });

  test("every state has words; recording carries the elapsed time; nothing relies on colour", () => {
    const recording = listenInMiniBarCopy(LISTEN_IN_MINI_BAR.RECORDING, { elapsedLabel: "1:05" });
    expect(recording.title).toBe("Recording");
    expect(recording.accessibleLabel).toMatch(/recording, 1:05/);
    expect(recording.accessibleLabel).toMatch(/Open Listen In/);
    const stopped = listenInMiniBarCopy(LISTEN_IN_MINI_BAR.STOPPED, { elapsedLabel: "1:05" });
    expect(stopped.title).toBe("Recording stopped");
    expect(stopped.detail).toBe("Meeting still open");
    expect(stopped.accessibleLabel).not.toMatch(/^Listen In — recording,/);
    expect(listenInMiniBarCopy(LISTEN_IN_MINI_BAR.INTERRUPTED).title).toBe("Interrupted");
    expect(listenInMiniBarCopy(LISTEN_IN_MINI_BAR.INTERRUPTED).detail).toMatch(/resume or complete/);
    expect(listenInMiniBarCopy(LISTEN_IN_MINI_BAR.COMPLETING).title).toBe("Completing meeting…");
    expect(listenInMiniBarCopy("unknown").title).toBe("");
  });

  test("the bar is shown for an unfinished meeting only while Listen In is not the screen", () => {
    const live = adapter(LISTEN_IN_STATE.RECORDING);
    expect(shouldShowListenInMiniBar({ listenIn: live, visibleTab: MOBILE_TAB.NOTE })).toBe(true);
    expect(shouldShowListenInMiniBar({ listenIn: live, visibleTab: MOBILE_TAB.LISTEN_IN })).toBe(false);
    expect(
      shouldShowListenInMiniBar({ listenIn: adapter(LISTEN_IN_STATE.FINISHED), visibleTab: MOBILE_TAB.NOTE })
    ).toBe(false);
  });
});

describe("the Projects drill-down", () => {
  test("browse position starts at the application selection and is not the selection itself", () => {
    expect(browsePathFromSelection({ activeProjectId: "p1", activeFolderId: "f1" })).toEqual({
      projectId: "p1",
      folderId: "f1",
    });
    expect(browsePathFromSelection()).toEqual({ projectId: null, folderId: null });
  });

  test("levels and back navigation", () => {
    expect(browseLevel({ projectId: null, folderId: null })).toBe(MOBILE_BROWSE_LEVEL.ROOT);
    expect(browseLevel({ projectId: "p1", folderId: null })).toBe(MOBILE_BROWSE_LEVEL.PROJECT);
    expect(browseLevel({ projectId: "p1", folderId: "f1" })).toBe(MOBILE_BROWSE_LEVEL.FOLDER);
    expect(browseParent({ projectId: "p1", folderId: "f1" })).toEqual({ projectId: "p1", folderId: null });
    expect(browseParent({ projectId: null, folderId: "rf1" })).toEqual({ projectId: null, folderId: null });
    expect(browseParent({ projectId: "p1", folderId: null })).toEqual({ projectId: null, folderId: null });
  });

  test("resolves each level against the real tree", () => {
    const root = resolveBrowse(TREE, { projectId: null, folderId: null });
    expect(root.level).toBe(MOBILE_BROWSE_LEVEL.ROOT);
    expect(root.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(root.rootFolders.map((f) => f.id)).toEqual(["rf1"]);
    expect(root.rootNotes.map((n) => n.id)).toEqual(["rn1"]);

    const project = resolveBrowse(TREE, { projectId: "p1", folderId: null });
    expect(project.level).toBe(MOBILE_BROWSE_LEVEL.PROJECT);
    expect(project.folders.map((f) => f.id)).toEqual(["f1"]);

    const folder = resolveBrowse(TREE, { projectId: "p1", folderId: "f1" });
    expect(folder.level).toBe(MOBILE_BROWSE_LEVEL.FOLDER);
    expect(folder.notes.map((n) => n.id)).toEqual(["n1"]);

    const rootFolder = resolveBrowse(TREE, { projectId: null, folderId: "rf1" });
    expect(rootFolder.level).toBe(MOBILE_BROWSE_LEVEL.FOLDER);
    expect(rootFolder.project).toBeNull();
    expect(rootFolder.notes.map((n) => n.id)).toEqual(["rfn1"]);
  });

  test("a position that no longer exists falls back to the nearest level that does", () => {
    expect(resolveBrowse(TREE, { projectId: "p1", folderId: "gone" }).path).toEqual({
      projectId: "p1",
      folderId: null,
    });
    expect(resolveBrowse(TREE, { projectId: "gone", folderId: "f1" }).level).toBe(MOBILE_BROWSE_LEVEL.ROOT);
    expect(resolveBrowse(TREE, { projectId: null, folderId: "gone" }).level).toBe(MOBILE_BROWSE_LEVEL.ROOT);
    // A project folder id is never resolved as a root folder, or vice versa.
    expect(resolveBrowse(TREE, { projectId: null, folderId: "f1" }).level).toBe(MOBILE_BROWSE_LEVEL.ROOT);
    expect(resolveBrowse(null, null).level).toBe(MOBILE_BROWSE_LEVEL.ROOT);
  });

  test("locateNote finds project, root-folder and root notes with their names", () => {
    expect(locateNote(TREE, "n1")).toEqual({
      noteId: "n1",
      title: "Day 1",
      projectId: "p1",
      projectName: "Harbour Bridge",
      folderId: "f1",
      folderName: "Site visits",
    });
    expect(locateNote(TREE, "rfn1")).toMatchObject({ projectId: null, folderId: "rf1", folderName: "Personal" });
    expect(locateNote(TREE, "rn1")).toMatchObject({ projectId: null, folderId: null, title: "Scratch" });
    expect(locateNote(TREE, "missing")).toBeNull();
    expect(locateNote(TREE, null)).toBeNull();
  });
});

describe("keyboard helpers", () => {
  test("the keyboard is open when the visual viewport is materially shorter than the layout viewport", () => {
    expect(keyboardInsetPx({ layoutHeight: 800, visualHeight: 480 })).toBe(320);
    expect(isKeyboardOpen({ layoutHeight: 800, visualHeight: 480 })).toBe(true);
    expect(isKeyboardOpen({ layoutHeight: 800, visualHeight: 800 - KEYBOARD_OPEN_THRESHOLD_PX + 1 })).toBe(false);
    expect(keyboardInsetPx({ layoutHeight: NaN, visualHeight: 400 })).toBe(0);
    expect(keyboardInsetPx({ layoutHeight: 400, visualHeight: 800 })).toBe(0);
  });

  test("text-entry focus is textareas, text inputs and contenteditable — not buttons or checkboxes", () => {
    const textarea = document.createElement("textarea");
    const text = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const readOnly = document.createElement("textarea");
    readOnly.readOnly = true;
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTextEntryElement(textarea)).toBe(true);
    expect(isTextEntryElement(text)).toBe(true);
    expect(isTextEntryElement(checkbox)).toBe(false);
    expect(isTextEntryElement(readOnly)).toBe(false);
    expect(isTextEntryElement(editable)).toBe(true);
    expect(isTextEntryElement(document.createElement("button"))).toBe(false);
    expect(isTextEntryElement(null)).toBe(false);
  });
});
