// src/components/mobile/PhoneShell.test.js
//
// THE PHONE SHELL, rendered (Phase 8E.1).
//
// The real shell over the REAL Listen In provider and engine (with a fake
// recorder and injected transport, as in ListenInWindowLifecycle.test.js) and
// the REAL Quick Add composer. The note workspace around the composer is a
// stand-in, because the document editor is not what is under test; the
// composer inside it is the real one, so its unsent draft, dictation and
// microphone ownership are real.
//
// The application state is a small stateful double with the application
// state's own selection semantics — in particular, selecting a folder CLOSES
// the open note, which is why the drill-down must never select while browsing.
import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PhoneShell from "./PhoneShell";
import { AppStateContext } from "../../context/AppStateContext";
import { ThemeProvider } from "../../context/ThemeContext";
import { LiveTranscriptContext, LiveTranscriptProvider } from "../../context/LiveTranscriptContext";
import { getListenInEngine, resetListenInEnginesForTests } from "../../lib/listenIn/listenInEngine";
import { createListenInMemoryStore } from "../../lib/listenIn/listenInStore";
import { LISTEN_IN_STATE } from "../../lib/listenIn/listenInModel";
import {
  MICROPHONE_OWNER,
  currentMicrophoneOwner,
  resetMicrophoneOwnershipForTests,
} from "../../lib/microphoneOwnership";
import { DICTATION_PHASE, dictationControlLabel } from "../../lib/quickAddDictation";
import { MOBILE_TAB } from "../../lib/mobileShell";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockScope = { uid: "uid-phone", workspace: { id: "ws-phone" } };
jest.mock("../../context/DataScopeContext", () => ({
  ...jest.requireActual("../../context/DataScopeContext"),
  useOptionalDataScope: () => mockScope,
}));

const mockTranscribeBlob = jest.fn();
jest.mock("../../hooks/useTranscription", () => ({
  useTranscription: () => ({ transcribeBlob: (...args) => mockTranscribeBlob(...args) }),
}));
const mockRefineText = jest.fn();
jest.mock("../../hooks/useRefine", () => ({
  useRefine: () => ({ refineText: (...args) => mockRefineText(...args) }),
}));

const mockSendComposer = jest.fn();
const mockInsertText = jest.fn();
jest.mock("../MainArea", () => {
  const mockReact = require("react");
  const MockBottomBar = require("../BottomBar").default;
  const { QUICK_ADD_KIND: mockKind } = require("../../lib/quickAddTarget");
  return function MockMainArea() {
    mockReact.useEffect(() => {
      globalThis.__phoneMainAreaMounts = (globalThis.__phoneMainAreaMounts || 0) + 1;
    }, []);
    return mockReact.createElement(
      "main",
      { "data-testid": "note-workspace" },
      mockReact.createElement(MockBottomBar, {
        // MainArea's real contract: a Free-form text-only Send is delivered
        // through onInsertText with an editor present.
        editor: {},
        onInsertText: (...args) => mockInsertText(...args),
        target: { kind: mockKind.FREEFORM },
        capture: { image: true, file: true },
        onSendComposer: (...args) => mockSendComposer(...args),
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

/* --------------------------------- fakes --------------------------------- */

class FakeMediaRecorder {
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || "";
    this.state = "inactive";
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob([new Uint8Array(16)], { type: this.mimeType }) });
    }
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

let tracks;
let summaryCalls;
let engine;

beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  globalThis.__phoneMainAreaMounts = 0;
  tracks = [{ stop: jest.fn() }];
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => tracks })) },
    configurable: true,
  });
  summaryCalls = [];
  mockInsertText.mockImplementation(() => true);
  mockSendComposer.mockImplementation(async () => ({
    ok: true,
    deliveredIds: [],
    textDelivered: true,
    stale: false,
  }));
  engine = getListenInEngine(mockScope.uid, mockScope.workspace.id, {
    store: createListenInMemoryStore(),
    transcribe: async () => "captured words",
    summarise: async (request) => {
      summaryCalls.push(request);
      return {
        ok: true,
        result: {
          summaryText: "A summary the user asked for.",
          keyPoints: [],
          decisions: [],
          actionItems: [],
          risks: [],
          followUps: [],
        },
      };
    },
    summaryPolicy: { minWindowChars: 1, maxWindowChars: 12000, minIntervalMs: 0, retryBackoffMs: [1], maxAutoAttempts: 4 },
    recorderSupported: () => true,
  });
});

afterEach(() => {
  resetListenInEnginesForTests();
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

function TestAppState({ apiRef, initial = {}, children }) {
  const [selection, setSelection] = useState({
    activeProjectId: initial.activeProjectId || null,
    activeFolderId: initial.activeFolderId || null,
  });
  const [currentNoteId, setNote] = useState(initial.currentNoteId || null);
  const [currentPdfId, setCurrentPdfId] = useState(null);
  const [workspace, setWorkspace] = useState(initial.workspace || "projects");
  const [noteWorkspaceTab, setNoteWorkspaceTab] = useState(initial.noteWorkspaceTab || "note");
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
    // The application state's semantics: selecting a folder closes the note.
    setActiveSelection: (pid, fid) => {
      setSelection({ activeProjectId: pid ?? null, activeFolderId: fid ?? null });
      setNote(null);
      setWorkspace("projects");
    },
    clearActiveSelection: () => setSelection({ activeProjectId: null, activeFolderId: null }),
    setCurrentNoteId: (nid) => {
      setNote(nid);
      if (nid) setWorkspace("projects");
    },
    setCurrentPdfId,
    getNotePdf: (nid) => (nid === "n1" ? "pdf-1" : null),
    getPdfDocById: (id) => PDFS[id] || null,
    listAllPdfs: () => Object.values(PDFS),
    createGlobalPdf: jest.fn(),
    createProject: jest.fn(),
    createFolder: jest.fn(),
    createRootFolder: jest.fn(),
    createRootNote: jest.fn(),
    addNoteToFolder: jest.fn(),
    addNoteToRootFolder: jest.fn(),
  };
  apiRef.current = value;
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

/* --------------------------------- harness -------------------------------- */

let host;
let root;
const app = { current: null };
const onOpenSettings = jest.fn();
const onOpenTemplateLibrary = jest.fn();

function tree(listenInValue, initial) {
  const shell = <PhoneShell onOpenSettings={onOpenSettings} onOpenTemplateLibrary={onOpenTemplateLibrary} />;
  return (
    <ThemeProvider>
      <TestAppState apiRef={app} initial={initial}>
        {listenInValue ? (
          <LiveTranscriptContext.Provider value={listenInValue}>{shell}</LiveTranscriptContext.Provider>
        ) : (
          <LiveTranscriptProvider>{shell}</LiveTranscriptProvider>
        )}
      </TestAppState>
    </ThemeProvider>
  );
}

async function mount({ listenInValue = null, initial = {} } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(tree(listenInValue, initial));
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
const tab = (id) => q(`[data-nw-phone-tab="${id}"]`);
const row = (id) => q(`[data-nw-phone-row-id="${id}"]`);
const visible = () =>
  [...host.querySelectorAll("[data-nw-phone-screen]")]
    .filter((el) => !el.hidden)
    .map((el) => el.getAttribute("data-nw-phone-screen"));
const listenIn = (name) =>
  q(`[data-nw-phone-screen="listen-in"] [data-listen-in-control="${name}"]`);
const miniBar = () => q("[data-listen-in-mini-bar]");
const composer = () => q('[data-nw-phone-screen="note"] textarea');

async function click(el) {
  expect(el).toBeTruthy();
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function type(el, text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openNoteN2() {
  await click(row("p1"));
  await click(row("f1"));
  await click(row("n2"));
}

async function startRecording() {
  await click(tab(MOBILE_TAB.LISTEN_IN));
  await click(listenIn("record"));
}

const meeting = () => engine.getSnapshot().session;

/* ================================ navigation =============================== */

describe("NAVIGATION — state survives moving around the phone", () => {
  test("browsing the drill-down never selects; opening a note commits its location and shows it", async () => {
    await mount();
    expect(visible()).toEqual([MOBILE_TAB.PROJECTS]);
    await click(row("p1"));
    expect(q('[data-nw-phone-browse="project"]')).not.toBeNull();
    await click(row("f1"));
    expect(q('[data-nw-phone-browse="folder"]')).not.toBeNull();
    // Looking is not selecting.
    expect(app.current.activeProjectId).toBeNull();
    expect(app.current.activeFolderId).toBeNull();

    await click(row("n2"));
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
    expect(app.current.currentNoteId).toBe("n2");
    expect(app.current.activeProjectId).toBe("p1");
    expect(app.current.activeFolderId).toBe("f1");
  });

  test("6/7. project selection, current note and drill-down position survive Projects → Note → Listen In → PDFs → Note", async () => {
    await mount();
    await openNoteN2();
    for (const next of [MOBILE_TAB.PROJECTS, MOBILE_TAB.NOTE, MOBILE_TAB.LISTEN_IN, MOBILE_TAB.PDFS, MOBILE_TAB.NOTE]) {
      await click(tab(next));
      expect(visible()).toEqual([next]);
      expect(app.current.currentNoteId).toBe("n2");
      expect(app.current.activeProjectId).toBe("p1");
      expect(app.current.activeFolderId).toBe("f1");
    }
    // Visiting Listen In created no meeting.
    expect(meeting()).toBeNull();
    await click(tab(MOBILE_TAB.PROJECTS));
    expect(q('[data-nw-phone-browse="folder"]')).not.toBeNull();
    expect(row("n2").getAttribute("aria-current")).toBe("true");
    expect(row("n2").textContent).toMatch(/Open note/);
  });

  test("going back up the drill-down never closes the open note", async () => {
    await mount();
    await openNoteN2();
    await click(tab(MOBILE_TAB.PROJECTS));
    await click(q('[aria-label="Back to Harbour Bridge"]'));
    await click(q('[aria-label="Back to Projects"]'));
    await click(row("p1"));
    expect(app.current.currentNoteId).toBe("n2");
  });

  test("the note bar returns to the note's folder in Projects", async () => {
    await mount();
    await openNoteN2();
    await click(q('[aria-label="Back to Harbour Bridge › Site visits"]'));
    expect(visible()).toEqual([MOBILE_TAB.PROJECTS]);
    expect(q('[data-nw-phone-browse="folder"]')).not.toBeNull();
  });

  test("8. the Quick Add draft survives every tab switch — the note workspace is mounted once and never remounted", async () => {
    await mount();
    await openNoteN2();
    const field = composer();
    await type(field, "Crack in the north abutment, photographed.");
    for (const next of [MOBILE_TAB.PROJECTS, MOBILE_TAB.LISTEN_IN, MOBILE_TAB.PDFS, MOBILE_TAB.MORE, MOBILE_TAB.NOTE]) {
      await click(tab(next));
    }
    expect(composer()).toBe(field);
    expect(composer().value).toBe("Crack in the north abutment, photographed.");
    expect(globalThis.__phoneMainAreaMounts).toBe(1);
    // Nothing reached the note: there has been no Send.
    expect(mockInsertText).not.toHaveBeenCalled();
    expect(mockSendComposer).not.toHaveBeenCalled();
  });

  test("a value left by the desktop shell (PDFs workspace, PDF tab) is brought back to the note view", async () => {
    await mount({ initial: { workspace: "pdfs", noteWorkspaceTab: "pdf", currentNoteId: "rn1" } });
    expect(app.current.workspace).toBe("projects");
    expect(app.current.noteWorkspaceTab).toBe("note");
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
  });
});

/* ============================ Listen In, real engine ======================== */

describe("LISTEN IN — the real meeting behind the phone screen and the mini-bar", () => {
  test("9/10/11/12. recording survives navigation; the mini-bar sits above the nav; tapping it reopens the SAME meeting", async () => {
    await mount();
    await startRecording();
    const id = meeting().sessionId;
    expect(meeting().state).toBe(LISTEN_IN_STATE.RECORDING);
    // On the Listen In screen itself there is no mini-bar.
    expect(miniBar()).toBeNull();

    await click(tab(MOBILE_TAB.PROJECTS));
    expect(visible()).toEqual([MOBILE_TAB.PROJECTS]);
    expect(meeting().sessionId).toBe(id);
    expect(meeting().state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(tracks[0].stop).not.toHaveBeenCalled();

    const bar = miniBar();
    expect(bar.getAttribute("data-listen-in-mini-bar")).toBe("recording");
    expect(bar.className).toMatch(/nw-phone-minibar--recording/);
    expect(bar.querySelector(".nw-listen-in-dot")).not.toBeNull();
    expect(bar.textContent).toMatch(/Recording/);
    expect(bar.getAttribute("aria-label")).toMatch(/^Listen In — recording, \d+:\d{2}/);
    // Directly above the bottom navigation, in the layout flow.
    const nav = q("[data-nw-phone-nav]");
    expect(nav.previousElementSibling).toBe(bar.closest("[data-nw-phone-minibar-slot]"));
    expect(bar.closest("[data-nw-phone-screen]")).toBeNull();
    // The Listen In tab says "recording" in words.
    expect(tab(MOBILE_TAB.LISTEN_IN).textContent).toMatch(/recording/);

    await click(bar);
    expect(visible()).toEqual([MOBILE_TAB.LISTEN_IN]);
    expect(meeting().sessionId).toBe(id);
    expect(miniBar()).toBeNull();
  });

  test("13. Close leaves the screen for the one the user came from, and recording carries on", async () => {
    await mount();
    await click(tab(MOBILE_TAB.PDFS));
    await startRecording();
    await click(listenIn("close"));
    expect(visible()).toEqual([MOBILE_TAB.PDFS]);
    expect(meeting().state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(miniBar().getAttribute("data-listen-in-mini-bar")).toBe("recording");
  });

  test("14. a stopped meeting keeps the mini-bar, without the red recording treatment", async () => {
    await mount();
    await startRecording();
    const id = meeting().sessionId;
    await click(listenIn("record")); // Stop recording
    expect(meeting().state).toBe(LISTEN_IN_STATE.PAUSED);
    await click(tab(MOBILE_TAB.NOTE));
    const bar = miniBar();
    expect(bar.getAttribute("data-listen-in-mini-bar")).toBe("stopped");
    expect(bar.className).not.toMatch(/--recording/);
    expect(bar.querySelector(".nw-listen-in-dot")).toBeNull();
    expect(bar.textContent).toMatch(/Recording stopped/);
    expect(bar.textContent).toMatch(/Meeting still open/);
    expect(tab(MOBILE_TAB.LISTEN_IN).querySelector(".nw-phone-nav__live")).toBeNull();
    // Reopening and starting again continues the SAME meeting.
    await click(bar);
    await click(listenIn("record"));
    expect(meeting().sessionId).toBe(id);
    expect(meeting().state).toBe(LISTEN_IN_STATE.RECORDING);
  });

  test("17/18/19. completing removes the unfinished-meeting bar; nothing summarises until Summarise is pressed", async () => {
    await mount();
    await startRecording();
    await click(listenIn("record")); // Stop
    await click(listenIn("record")); // Start again, same meeting
    await click(listenIn("record")); // Stop
    expect(summaryCalls).toHaveLength(0);
    await click(listenIn("complete"));
    await flush();
    expect(meeting().state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(summaryCalls).toHaveLength(0);

    await click(tab(MOBILE_TAB.PROJECTS));
    expect(miniBar()).toBeNull();

    await click(tab(MOBILE_TAB.LISTEN_IN));
    expect(q('[data-nw-phone-screen="listen-in"] [data-listen-in-section="summarised"]')).toBeNull();
    await click(listenIn("summarise"));
    await flush();
    expect(summaryCalls.length).toBeGreaterThan(0);
    expect(q('[data-nw-phone-screen="listen-in"] [data-listen-in-section="summarised"]')).not.toBeNull();
    // Clear, not Discard.
    expect(listenIn("discard")).toBeNull();
    await click(listenIn("clear"));
    expect(meeting()).toBeNull();
  });

  test("21/25. Dictate is not Listen In, and the microphone stays with the live meeting", async () => {
    await mount({ initial: { currentNoteId: "rn1" } });
    await startRecording();
    await click(tab(MOBILE_TAB.NOTE));
    const dictate = q(`[data-nw-phone-screen="note"] [aria-label="${dictationControlLabel(DICTATION_PHASE.IDLE)}"]`);
    await click(dictate);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(meeting().state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
    expect(q('[data-nw-phone-screen="note"] [role="alert"]')).not.toBeNull();
  });

  test("21. with the microphone free, Dictate records into Quick Add and never opens or starts Listen In", async () => {
    await mount({ initial: { currentNoteId: "rn1" } });
    const dictate = q(`[aria-label="${dictationControlLabel(DICTATION_PHASE.IDLE)}"]`);
    await click(dictate);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    expect(meeting()).toBeNull();
    expect(visible()).toEqual([MOBILE_TAB.NOTE]);
    expect(miniBar()).toBeNull();
    await click(q('[aria-label="Discard dictation"]'));
    expect(currentMicrophoneOwner()).toBeNull();
  });
});

/* ======================= mini-bar states from the adapter =================== */

function adapterValue(state, over = {}) {
  return {
    session: state ? { sessionId: "s1", state, startedAt: 1000, capturedMs: 125000, legStartedAt: null } : null,
    chunks: [],
    recording: state === LISTEN_IN_STATE.RECORDING,
    paused: state === LISTEN_IN_STATE.PAUSED,
    interrupted: state === LISTEN_IN_STATE.INTERRUPTED,
    completing: state === LISTEN_IN_STATE.FINISHING,
    finishing: state === LISTEN_IN_STATE.FINISHING,
    finished: state === LISTEN_IN_STATE.FINISHED,
    active: !!state && state !== LISTEN_IN_STATE.FINISHED,
    open: false,
    openWorkspace: jest.fn(),
    closeWorkspace: jest.fn(),
    start: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    complete: jest.fn(),
    discard: jest.fn(),
    ...over,
  };
}

describe("LISTEN IN — every unfinished state is represented on the mini-bar", () => {
  test("15. interrupted: a recoverable interruption, not a recording", async () => {
    await mount({ listenInValue: adapterValue(LISTEN_IN_STATE.INTERRUPTED) });
    const bar = miniBar();
    expect(bar.getAttribute("data-listen-in-mini-bar")).toBe("interrupted");
    expect(bar.textContent).toMatch(/Interrupted/);
    expect(bar.textContent).toMatch(/resume or complete/);
    expect(bar.className).not.toMatch(/--recording/);
  });

  test("16. completing: a concise completing state", async () => {
    await mount({ listenInValue: adapterValue(LISTEN_IN_STATE.FINISHING) });
    expect(miniBar().getAttribute("data-listen-in-mini-bar")).toBe("completing");
    expect(miniBar().textContent).toMatch(/Completing meeting…/);
  });

  test("17. completed, or no meeting: no mini-bar", async () => {
    await mount({ listenInValue: adapterValue(LISTEN_IN_STATE.FINISHED) });
    expect(miniBar()).toBeNull();
    act(() => root.render(tree(adapterValue(null))));
    expect(miniBar()).toBeNull();
  });

  test("12. tapping the bar only opens Listen In — it starts, stops and completes nothing", async () => {
    const value = await (async () => {
      const v = adapterValue(LISTEN_IN_STATE.RECORDING, { legStartedAt: Date.now() });
      await mount({ listenInValue: v });
      return v;
    })();
    await click(miniBar());
    expect(value.openWorkspace).toHaveBeenCalledTimes(1);
    for (const name of ["start", "pause", "resume", "complete", "discard", "closeWorkspace"]) {
      expect(value[name]).not.toHaveBeenCalled();
    }
  });
});

/* ================================= capture ================================= */

describe("CAPTURE — the real Quick Add composer on the Note screen", () => {
  test("20/23. text entry, and nothing is sent until Send", async () => {
    await mount({ initial: { currentNoteId: "rn1" } });
    const send = q('[data-nw-phone-screen="note"] button[aria-label^="Send Quick Add"]');
    expect(send.disabled).toBe(true);
    await type(composer(), "Bearing pad displaced.");
    expect(mockInsertText).not.toHaveBeenCalled();
    expect(mockSendComposer).not.toHaveBeenCalled();
    expect(send.disabled).toBe(false);
    await click(send);
    expect(mockInsertText).toHaveBeenCalledTimes(1);
    expect(mockInsertText).toHaveBeenCalledWith("Bearing pad displaced.");
    // The delivered draft is cleared, as it is on desktop.
    expect(composer().value).toBe("");
  });

  test("22. the dictation language chip is on the phone composer and keeps its choice across navigation", async () => {
    await mount({ initial: { currentNoteId: "rn1" } });
    const select = q('[data-nw-phone-screen="note"] .nw-voice-lang-compact select');
    expect(select).not.toBeNull();
    const choice = [...select.options].map((o) => o.value).find((v) => v && v !== select.value);
    await act(async () => {
      select.value = choice;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(tab(MOBILE_TAB.MORE));
    await click(tab(MOBILE_TAB.NOTE));
    expect(q('[data-nw-phone-screen="note"] .nw-voice-lang-compact select').value).toBe(choice);
  });

  test("24/31. camera and attachment entry points are real buttons in the composer's controls row", async () => {
    await mount({ initial: { currentNoteId: "rn1" } });
    const controls = q('[data-nw-phone-screen="note"] [data-nw-quickadd-controls]');
    const camera = controls.querySelector('button[aria-label="Take a photo with the camera"]');
    expect(camera).not.toBeNull();
    const cameraInput = controls.querySelector('input[type="file"][capture="environment"]');
    expect(cameraInput.getAttribute("accept")).toBe("image/*");
    const attachInput = controls.querySelector('input[type="file"][multiple]');
    const attach = controls.querySelector(`button[aria-label="${attachInput.getAttribute("aria-label")}"]`);
    expect(attach).not.toBeNull();
    // Reachable by a tap: nothing in the phone shell waits for hover.
    for (const el of host.querySelectorAll("[onmouseenter], [onmouseover]")) {
      expect(el).toBeNull();
    }
  });
});

/* =================================== PDFs =================================== */

describe("PDFS — the phone viewer route", () => {
  test("28. the PDFs screen lists documents and opens one in the phone viewer", async () => {
    await mount();
    await click(tab(MOBILE_TAB.PDFS));
    await click(row("pdf-1"));
    expect(app.current.currentPdfId).toBe("pdf-1");
    const viewer = q('[data-nw-phone-screen="pdfs"] [data-testid="phone-pdf-viewer"]');
    expect(viewer.getAttribute("data-doc")).toBe("pdf-1");
    expect(q("[data-pdf-editor]")).toBeNull();
    await click(q('[aria-label="Back to PDFs"]'));
    expect(app.current.currentPdfId).toBeNull();
    expect(row("pdf-1")).not.toBeNull();
  });

  test("a note's linked PDF opens in the phone viewer from the note bar", async () => {
    await mount();
    await click(row("p1"));
    await click(row("f1"));
    await click(row("n1"));
    await click(q('[data-nw-phone-view="pdf"]'));
    expect(visible()).toEqual([MOBILE_TAB.PDFS]);
    expect(q('[data-testid="phone-pdf-viewer"]').getAttribute("data-doc")).toBe("pdf-1");
    // The note is still the open note.
    expect(app.current.currentNoteId).toBe("n1");
  });
});

/* ============================ keyboard and More ============================= */

describe("LAYOUT — the keyboard and the More screen", () => {
  const realVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
  afterEach(() => {
    if (realVisualViewport) Object.defineProperty(window, "visualViewport", realVisualViewport);
    else delete window.visualViewport;
  });

  test("typing with the keyboard up hides the bottom nav; a live meeting's mini-bar stays", async () => {
    const listeners = {};
    const vv = {
      height: window.innerHeight,
      offsetTop: 0,
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      removeEventListener: () => {},
    };
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    await mount({
      initial: { currentNoteId: "rn1" },
      listenInValue: adapterValue(LISTEN_IN_STATE.RECORDING, { legStartedAt: Date.now() }),
    });
    expect(q("[data-nw-phone-nav]")).not.toBeNull();

    await act(async () => {
      composer().focus();
      vv.height = window.innerHeight - 320;
      listeners.resize();
    });
    await flush();
    expect(q("[data-nw-phone-nav]")).toBeNull();
    expect(miniBar()).not.toBeNull();
    expect(q('[data-nw-shell="phone"]').style.height).toBe(`${Math.round(window.innerHeight - 320)}px`);

    await act(async () => {
      composer().blur();
      vv.height = window.innerHeight;
      listeners.resize();
    });
    await flush();
    expect(q("[data-nw-phone-nav]")).not.toBeNull();
    expect(q('[data-nw-shell="phone"]').style.height).toBe("");
  });

  test("three distinct controls: Free-form MODE and Template MODE switch the current note; the top-right Template Library opens the Builder", async () => {
    onOpenTemplateLibrary.mockClear();
    await mount({ initial: { currentNoteId: "rn1" } });
    const bar = q('[data-nw-phone-screen="note"] [data-nw-phone-notebar]');
    // 1/2. The note's two modes, in the note bar's "Note view" group.
    const freeform = bar.querySelector('[data-nw-phone-view="freeform"]');
    const template = bar.querySelector('[data-nw-phone-view="template-form"]');
    expect(freeform.getAttribute("aria-pressed")).toBe("true");
    await click(template);
    expect(app.current.activeNoteView).toBe("template");
    expect(template.getAttribute("aria-pressed")).toBe("true");
    await click(freeform);
    expect(app.current.activeNoteView).toBe("natural");
    // 5. Switching the note's mode never opened the Builder.
    expect(onOpenTemplateLibrary).not.toHaveBeenCalled();
    // 3. The Builder is its own action at the TOP-RIGHT of the note bar — the
    // historical control, beside the mode segment and never inside it.
    const builder = bar.querySelector("[data-nw-phone-template-library]");
    expect(builder).not.toBeNull();
    expect(builder.getAttribute("aria-label")).toBe("Open Template Library — create and manage reusable templates");
    expect(builder.getAttribute("aria-haspopup")).toBe("dialog");
    expect(builder.textContent).toBe("Template Library");
    expect(bar.querySelector('[role="group"][aria-label="Note view"]').contains(builder)).toBe(false);
    expect(template.compareDocumentPosition(builder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 4. Clicking it opens the Builder…
    await click(builder);
    expect(onOpenTemplateLibrary).toHaveBeenCalledTimes(1);
    // 6. …and changes no note mode and no note.
    expect(app.current.activeNoteView).toBe("natural");
    expect(app.current.currentNoteId).toBe("rn1");
    // 7. More carries no replacement entry point.
    await click(tab(MOBILE_TAB.MORE));
    expect(q('[data-nw-phone-more="template-library"]')).toBeNull();
    expect(q('[data-nw-phone-screen="more"]').textContent).not.toMatch(/Template Library/);
  });

  test("More opens the existing Settings dialog through the application shell", async () => {
    onOpenSettings.mockClear();
    await mount();
    await click(tab(MOBILE_TAB.MORE));
    await click(q('[data-nw-phone-more="settings"]'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
