// src/components/ListenInPhonePresentation.test.js
//
// THE LISTEN IN WORKSPACE, PHONE PRESENTATION (Phase 8E.1), rendered.
//
// The phone screen is the SAME component as the desktop window
// (ListenInWindow) in a different frame. These tests prove the frame differs
// and the behaviour does not: Close is the provider's one boolean, the record
// control stops a leg and never completes, Complete is its own control,
// Summarise is manual, the summary appears beneath the transcript only once it
// exists, and a completed meeting is left with Clear while an unfinished one
// keeps Discard.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import LiveTranscriptDialog, { LISTEN_IN_PRESENTATION, ListenInWindow } from "./LiveTranscriptDialog";
import { LiveTranscriptContext } from "../context/LiveTranscriptContext";
import { CHUNK_STATE, LISTEN_IN_STATE } from "../lib/listenIn/listenInModel";
import { LISTEN_IN_SUMMARY_STATUS } from "../lib/listenIn/listenInSummaryModel";

global.IS_REACT_ACT_ENVIRONMENT = true;

const RESULT = {
  summaryText: "The team agreed the survey date.",
  keyPoints: ["Three boreholes were logged."],
  decisions: [],
  actionItems: [],
  risks: [],
  followUps: [],
};

function chunk(seq, text) {
  return {
    seq,
    state: CHUNK_STATE.TRANSCRIBED,
    text,
    attempts: 0,
    startedAt: 1000 + seq * 30000,
    endedAt: 1000 + (seq + 1) * 30000,
    language: "en",
    speaker: null,
  };
}

const CHUNKS = [chunk(0, "Right, let us walk the site."), chunk(1, "Agreed, we move the survey.")];

function capture(state) {
  return {
    uid: "u1",
    workspaceId: "w1",
    sessionId: "s1",
    title: "Listen In — test",
    startedAt: 1000,
    stoppedAt: null,
    capturedMs: 65000,
    legStartedAt: state === LISTEN_IN_STATE.RECORDING ? Date.now() - 5000 : null,
    language: "en",
    state,
  };
}

function summaryRecord() {
  return {
    status: LISTEN_IN_SUMMARY_STATUS.READY,
    revision: 1,
    result: RESULT,
    parts: [{ fromSeq: 0, toSeq: 1, result: RESULT }],
    coveredThroughSeq: 1,
    missingSeqs: [],
    final: true,
    userSummaryText: null,
    lastErrorOutcome: null,
    lastErrorMessage: null,
  };
}

/** The adapter's real shape (useLiveTranscript + provider), for one state. */
function value(state, over = {}) {
  const summary = over.summary === undefined ? null : over.summary;
  const base = {
    engine: {},
    session: capture(state),
    chunks: CHUNKS,
    error: null,
    pending: 0,
    failed: 0,
    survivesReload: true,
    supported: true,
    recording: state === LISTEN_IN_STATE.RECORDING,
    paused: state === LISTEN_IN_STATE.PAUSED,
    interrupted: state === LISTEN_IN_STATE.INTERRUPTED,
    active: state !== LISTEN_IN_STATE.FINISHED,
    completing: false,
    finishing: false,
    finished: state === LISTEN_IN_STATE.FINISHED,
    finishedWithIssues: false,
    limitWarned: false,
    stoppedAtLimit: false,
    canResume: state === LISTEN_IN_STATE.PAUSED || state === LISTEN_IN_STATE.INTERRUPTED,
    duration: { capturedMs: 65000 },
    transcript: CHUNKS.map((c) => c.text).join(" "),
    segments: CHUNKS,
    summary,
    summaryCoverage: {
      transcribedThroughSeq: 1,
      summaryThroughSeq: summary ? 1 : -1,
      pendingCount: 0,
      failedCount: 0,
      missingSeqs: [],
      behind: false,
      capturing: false,
      complete: true,
    },
    summaryText: summary ? RESULT.summaryText : "",
    hasSummary: !!summary,
    language: "en",
    chooseLanguage: jest.fn(),
    open: true,
    openWorkspace: jest.fn(),
    closeWorkspace: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    complete: jest.fn(),
    finish: jest.fn(),
    discard: jest.fn(),
    retryFailed: jest.fn(),
    retrySummary: jest.fn(),
    regenerateSummary: jest.fn(),
    summariseNow: jest.fn(),
    clear: jest.fn(),
    editSummaryText: jest.fn(),
    clearError: jest.fn(),
  };
  return { ...base, ...over, summary };
}

let host;
let root;

function mount(v, element = <ListenInWindow presentation={LISTEN_IN_PRESENTATION.PHONE} />) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<LiveTranscriptContext.Provider value={v}>{element}</LiveTranscriptContext.Provider>));
  return v;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const control = (name) => host.querySelector(`[data-listen-in-control="${name}"]`);
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const NOT_CALLED = ["start", "stop", "pause", "resume", "complete", "finish", "discard", "clear"];

describe("the phone frame", () => {
  test("a labelled page, not a modal dialog; the desktop window keeps its dialog frame", () => {
    mount(value(LISTEN_IN_STATE.RECORDING));
    const page = host.querySelector('[data-listen-in-presentation="phone"]');
    expect(page).not.toBeNull();
    expect(page.tagName).toBe("SECTION");
    expect(page.getAttribute("aria-labelledby")).toBeTruthy();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(".fixed.inset-0")).toBeNull();
    act(() => root.unmount());
    host.remove();

    mount(value(LISTEN_IN_STATE.RECORDING), <LiveTranscriptDialog />);
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("data-listen-in-presentation")).toBe("dialog");
  });

  test("the same header facts: title, elapsed time, status sentence, language", () => {
    mount(value(LISTEN_IN_STATE.RECORDING));
    expect(host.querySelector('[data-listen-in-part="title"]').textContent).toBe("Listen In");
    expect(host.querySelector('[data-listen-in-part="elapsed"]').textContent).toMatch(/^\d+:\d{2}$/);
    expect(host.querySelector('[data-listen-in-state] > [role="status"]').textContent).toMatch(/Recording/);
    expect(host.querySelector('[data-listen-in-part="language"] select')).not.toBeNull();
  });

  test("renders nothing while the provider says closed", () => {
    mount(value(LISTEN_IN_STATE.RECORDING, { open: false }));
    expect(host.querySelector('[data-listen-in-presentation="phone"]')).toBeNull();
  });
});

describe("the three actions are never conflated", () => {
  test("Close is the provider's close and nothing else — recording is untouched", () => {
    const v = mount(value(LISTEN_IN_STATE.RECORDING));
    expect(control("close").getAttribute("aria-label")).toBe("Close Listen In (recording continues)");
    click(control("close"));
    expect(v.closeWorkspace).toHaveBeenCalledTimes(1);
    for (const name of NOT_CALLED) expect(v[name]).not.toHaveBeenCalled();
  });

  test("recording: the record control is Stop recording and pauses the leg; Complete is separate", () => {
    const v = mount(value(LISTEN_IN_STATE.RECORDING));
    expect(control("record").textContent).toBe("Stop recording");
    expect(control("record").getAttribute("aria-pressed")).toBe("true");
    click(control("record"));
    expect(v.pause).toHaveBeenCalledTimes(1);
    expect(v.complete).not.toHaveBeenCalled();
    click(control("complete"));
    expect(v.complete).toHaveBeenCalledTimes(1);
  });

  test("stopped: Start recording continues the SAME meeting (resume), not a new one", () => {
    const v = mount(value(LISTEN_IN_STATE.PAUSED));
    expect(control("record").textContent).toBe("Start recording");
    click(control("record"));
    expect(v.resume).toHaveBeenCalledTimes(1);
    expect(v.start).not.toHaveBeenCalled();
    expect(control("complete")).not.toBeNull();
  });

  test("interrupted: Resume meeting and Complete meeting", () => {
    mount(value(LISTEN_IN_STATE.INTERRUPTED));
    expect(control("record").textContent).toBe("Resume meeting");
    expect(control("complete")).not.toBeNull();
  });
});

describe("summarisation is manual, and the summary sits under the transcript", () => {
  test("no summary: Summarise is offered and nothing is summarised until it is pressed", () => {
    const v = mount(value(LISTEN_IN_STATE.PAUSED));
    expect(host.querySelector('[data-listen-in-section="summarised"]')).toBeNull();
    expect(v.summariseNow).not.toHaveBeenCalled();
    expect(control("summarise").textContent).toBe("Summarise");
    click(control("summarise"));
    expect(v.summariseNow).toHaveBeenCalledTimes(1);
  });

  test("a requested summary appears beneath the Original transcript", () => {
    mount(value(LISTEN_IN_STATE.FINISHED, { summary: summaryRecord() }));
    const page = host.querySelector('[data-listen-in-page="single"]');
    const order = [...page.children]
      .map((el) => el.getAttribute("data-listen-in-section") || el.getAttribute("data-listen-in-summarise"))
      .filter(Boolean);
    expect(order).toEqual(["transcript", "control", "summarised"]);
    expect(control("summarise").textContent).toBe("Summarise again");
  });
});

describe("leaving a meeting", () => {
  test("completed: Clear (non-destructive) and Export — never Discard", () => {
    const v = mount(value(LISTEN_IN_STATE.FINISHED));
    expect(control("discard")).toBeNull();
    expect(control("export")).not.toBeNull();
    click(control("clear"));
    expect(v.clear).toHaveBeenCalledTimes(1);
    expect(v.discard).not.toHaveBeenCalled();
  });

  test("unfinished and stopped: Discard remains, and Clear is absent", () => {
    mount(value(LISTEN_IN_STATE.PAUSED));
    expect(control("clear")).toBeNull();
    expect(control("discard")).not.toBeNull();
  });
});
