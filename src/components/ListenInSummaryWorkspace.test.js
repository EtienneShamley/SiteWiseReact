// src/components/ListenInSummaryWorkspace.test.js
//
// THE LISTEN IN WINDOW AS THE USER MEETS IT (Phase 8D.2), rendered.
//
// Two views over one session — Summary and Transcript — with Summary the
// default once there is one to read. Everything here is asserted from the DOM
// rather than from the component's source: what is on screen, what is not, and
// what pressing something does.
//
// The facts it exists to hold:
//   - both views exist, Summary is the default when appropriate;
//   - the transcript is READ-FIRST, complete, in order, with failed parts named
//     and pending parts shown as pending — never as silence;
//   - an action item with no stated owner is shown without one;
//   - the summary says what it covers, and never claims completeness while
//     transcription is behind it;
//   - there is NO Summarise button and NO Insert action anywhere;
//   - a summary failure is reported with a retry, and says the recording is
//     unaffected;
//   - an edit is stored on the session, and regeneration is explicit.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import LiveTranscriptDialog from "./LiveTranscriptDialog";
import { LiveTranscriptContext } from "../context/LiveTranscriptContext";
import { CHUNK_STATE, LISTEN_IN_STATE, transcriptBlocks } from "../lib/listenIn/listenInModel";
import { LISTEN_IN_SUMMARY_STATUS } from "../lib/listenIn/listenInSummaryModel";

global.IS_REACT_ACT_ENVIRONMENT = true;

const RESULT = {
  summaryText: "The team walked the site and agreed the survey date.\n\nCosts were reviewed.",
  keyPoints: ["Three boreholes were logged."],
  decisions: ["The survey moves to Friday."],
  actionItems: [
    { task: "Send the borehole logs", owner: "Priya", dueDate: "Friday", sourceSeq: 1 },
    { task: "Chase the rig quote", owner: null, dueDate: null, sourceSeq: null },
  ],
  risks: ["Rain may stop work."],
  followUps: ["Confirm the rig booking."],
};

const EMPTY_RESULT = {
  summaryText: "",
  keyPoints: [],
  decisions: [],
  actionItems: [],
  risks: [],
  followUps: [],
};

function chunk(seq, state, text = "", attempts = 0) {
  return {
    seq,
    state,
    text,
    attempts,
    startedAt: 1000 + seq * 30000,
    endedAt: 1000 + (seq + 1) * 30000,
    language: "en",
    speaker: null,
  };
}

const CAPTURE = {
  uid: "u1",
  workspaceId: "w1",
  sessionId: "s1",
  title: "Listen In — test",
  startedAt: 1000,
  stoppedAt: 200000,
  capturedMs: 199000,
  legStartedAt: null,
  language: "en",
  state: LISTEN_IN_STATE.FINISHED,
};

function summaryRecord(over = {}) {
  return {
    status: LISTEN_IN_SUMMARY_STATUS.READY,
    revision: 2,
    result: RESULT,
    parts: [{ fromSeq: 0, toSeq: 2, result: RESULT }],
    coveredThroughSeq: 2,
    missingSeqs: [],
    final: true,
    userSummaryText: null,
    lastErrorOutcome: null,
    lastErrorMessage: null,
    ...over,
  };
}

function coverage(over = {}) {
  return {
    transcribedThroughSeq: 2,
    summaryThroughSeq: 2,
    pendingCount: 0,
    failedCount: 0,
    missingSeqs: [],
    behind: false,
    capturing: false,
    complete: true,
    ...over,
  };
}

const DEFAULT_CHUNKS = [
  chunk(0, CHUNK_STATE.TRANSCRIBED, "Right, let us walk the site."),
  chunk(1, CHUNK_STATE.TRANSCRIBED, "Priya, send the borehole logs by Friday."),
  chunk(2, CHUNK_STATE.TRANSCRIBED, "Agreed, we will move the survey."),
];

/** The context value the window reads — the hook's real shape. */
function sessionValue(over = {}) {
  const chunks = over.chunks || DEFAULT_CHUNKS;
  const summary = "summary" in over ? over.summary : summaryRecord();
  const capture = over.session === undefined ? CAPTURE : over.session;
  const base = {
    engine: {},
    session: capture,
    chunks,
    error: null,
    pending: 0,
    failed: 0,
    survivesReload: true,
    supported: true,
    recording: false,
    interrupted: false,
    // Phase 8D.3: the window reads the session's four-hour capture budget from
    // the engine. The default stub is a session well inside it — Resume is
    // offered for an interrupted one, and the duration banners are absent.
    duration: {
      capturedMs: 65000,
      warnAfterMs: 2 * 60 * 60 * 1000,
      maxMs: 4 * 60 * 60 * 1000,
      shouldWarn: false,
      warned: false,
      exhausted: false,
      remainingMs: 4 * 60 * 60 * 1000 - 65000,
      untilWarningMs: 2 * 60 * 60 * 1000 - 65000,
    },
    limitWarned: false,
    stoppedAtLimit: false,
    canResume: false,
    // 8D.3.1: the meeting's own lifecycle facts. The default stub is a
    // completed meeting — not active, so the window offers Start.
    active: false,
    paused: false,
    completing: false,
    pause: jest.fn(),
    complete: jest.fn(),
    finishing: false,
    finished: true,
    finishedWithIssues: false,
    transcript: chunks
      .filter((c) => c.state === CHUNK_STATE.TRANSCRIBED)
      .map((c) => c.text)
      .join(" "),
    segments: chunks,
    summary,
    summaryCoverage: coverage(over.summaryCoverage || {}),
    summaryText: summary ? summary.userSummaryText || summary.result.summaryText : "",
    hasSummary: !!summary && !!(summary.userSummaryText || summary.result.summaryText),
    language: "auto",
    chooseLanguage: jest.fn(),
    open: true,
    openWorkspace: jest.fn(),
    closeWorkspace: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    resume: jest.fn(),
    finish: jest.fn(),
    discard: jest.fn(),
    retryFailed: jest.fn(),
    retrySummary: jest.fn(),
    regenerateSummary: jest.fn(),
    editSummaryText: jest.fn(),
    clearError: jest.fn(),
  };
  return { ...base, ...over, summaryCoverage: base.summaryCoverage, summary, chunks };
}

let host;
let root;

function mount(value) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <LiveTranscriptContext.Provider value={value}>
        <LiveTranscriptDialog />
      </LiveTranscriptContext.Provider>
    )
  );
  return value;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const buttons = () => [...document.querySelectorAll("button")];
const byText = (re) => buttons().find((b) => re.test(b.textContent.trim()));
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const tab = (name) => document.querySelector(`[data-listen-in-tab="${name}"]`);
const viewOf = (name) => document.querySelector(`[data-listen-in-view="${name}"]`);
const text = () => document.body.textContent;

/* ============================ 1. the two views =========================== */

describe("1. the window has a Summary view and a Transcript view", () => {
  test("both are offered as a labelled group of pressed-state toggles", () => {
    mount(sessionValue());
    const group = document.querySelector('[role="group"][aria-label="Listen In view"]');
    expect(group).not.toBeNull();
    expect([...group.querySelectorAll("button")].map((b) => b.textContent.trim())).toEqual([
      "Summary",
      "Transcript",
    ]);
    expect(tab("summary").getAttribute("aria-pressed")).toBe("true");
    expect(tab("transcript").getAttribute("aria-pressed")).toBe("false");
  });

  test("SUMMARY is the default once there is a summary to read", () => {
    mount(sessionValue());
    expect(viewOf("summary")).not.toBeNull();
    expect(viewOf("transcript")).toBeNull();
    expect(text()).toContain("The team walked the site");
  });

  test("with nothing summarised yet the TRANSCRIPT is what opens", () => {
    mount(sessionValue({ summary: summaryRecord({ result: EMPTY_RESULT, final: false }) }));
    expect(viewOf("transcript")).not.toBeNull();
    expect(viewOf("summary")).toBeNull();
    expect(text()).toContain("Right, let us walk the site.");
  });

  test("switching is one press, and the choice sticks", () => {
    mount(sessionValue());
    click(tab("transcript"));
    expect(viewOf("transcript")).not.toBeNull();
    expect(tab("transcript").getAttribute("aria-pressed")).toBe("true");
    click(tab("summary"));
    expect(viewOf("summary")).not.toBeNull();
  });
});

/* ============================== 2. the summary =========================== */

describe("2. the summary is structured meeting intelligence", () => {
  test("the overview and every non-empty section are rendered under their headings", () => {
    mount(sessionValue());
    expect(text()).toContain("The team walked the site and agreed the survey date.");
    expect(text()).toContain("Costs were reviewed.");
    for (const heading of ["Key points", "Decisions", "Action items", "Risks and issues", "Follow-ups"]) {
      expect(document.querySelector(`[data-listen-in-section="${heading}"]`)).not.toBeNull();
    }
    expect(text()).toContain("Three boreholes were logged.");
    expect(text()).toContain("The survey moves to Friday.");
  });

  test("an EMPTY section is omitted rather than shown as a finding of none", () => {
    mount(
      sessionValue({
        summary: summaryRecord({
          result: { ...RESULT, risks: [], followUps: [] },
        }),
      })
    );
    expect(document.querySelector('[data-listen-in-section="Decisions"]')).not.toBeNull();
    expect(document.querySelector('[data-listen-in-section="Risks and issues"]')).toBeNull();
    expect(document.querySelector('[data-listen-in-section="Follow-ups"]')).toBeNull();
    expect(text()).not.toMatch(/None recorded|No risks/i);
  });

  test("AN OWNER OR A DATE IS SHOWN ONLY WHERE THE TRANSCRIPT STATED ONE", () => {
    mount(sessionValue());
    const items = [...document.querySelectorAll('[data-listen-in-section="Action items"] li')].map(
      (li) => li.textContent
    );
    expect(items[0]).toBe("Send the borehole logs (Priya, due Friday)");
    // The second item had neither: it is the task, and nothing is appended.
    expect(items[1]).toBe("Chase the rig quote");
    expect(items[1]).not.toMatch(/TBD|unknown|null|due/i);
  });
});

/* ============================== 3. coverage ============================== */

describe("3. the summary states what it covers and never overclaims", () => {
  test("a final summary over a whole recording says so, with no caveat", () => {
    mount(sessionValue());
    expect(document.querySelector("[data-listen-in-summary-status]").textContent).toBe(
      "Final summary."
    );
    expect(document.querySelector('[data-listen-in-coverage="incomplete"]')).toBeNull();
  });

  test("an in-progress summary behind the transcript says BOTH things", () => {
    mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.RECORDING },
        recording: true,
        finished: false,
        summary: summaryRecord({ final: false, coveredThroughSeq: 1 }),
        summaryCoverage: { behind: true, capturing: true, pendingCount: 1, complete: false },
      })
    );
    expect(document.querySelector("[data-listen-in-summary-status]").textContent).toMatch(
      /in progress — it does not yet cover the whole meeting/
    );
  });

  test("a final summary over a recording with holes names them, on screen", () => {
    mount(
      sessionValue({
        chunks: [
          chunk(0, CHUNK_STATE.TRANSCRIBED, "One."),
          chunk(1, CHUNK_STATE.FAILED, "", 5),
          chunk(2, CHUNK_STATE.TRANSCRIBED, "Three."),
        ],
        failed: 1,
        finishedWithIssues: true,
        summary: summaryRecord({ missingSeqs: [1] }),
        summaryCoverage: { failedCount: 1 },
      })
    );
    const note = document.querySelector('[data-listen-in-coverage="incomplete"]');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/does not cover the whole recording/);
    expect(document.querySelector("[data-listen-in-summary-status]").textContent).toMatch(
      /one part of the recording could not be transcribed/i
    );
  });

  test("waiting for the first transcript says what it is waiting for", () => {
    mount(
      sessionValue({
        chunks: [chunk(0, CHUNK_STATE.SEALED)],
        summary: summaryRecord({ result: EMPTY_RESULT, final: false, coveredThroughSeq: -1 }),
        summaryCoverage: { pendingCount: 1, transcribedThroughSeq: -1, summaryThroughSeq: -1, complete: false },
      })
    );
    click(tab("summary"));
    expect(text()).toMatch(/Waiting for enough transcript/);
  });
});

/* ============================= 4. the transcript ========================= */

describe("4. the transcript is read-first, complete and in order", () => {
  test("it renders the canonical ordered segments with elapsed offsets", () => {
    mount(sessionValue());
    click(tab("transcript"));
    const body = viewOf("transcript").textContent;
    expect(body.indexOf("Right, let us walk the site.")).toBeLessThan(
      body.indexOf("Agreed, we will move the survey.")
    );
    // Offsets are relative to the session, not a wall clock.
    expect(body).toContain("0:00");
  });

  test("it is NOT an editable textarea", () => {
    mount(sessionValue());
    click(tab("transcript"));
    expect(viewOf("transcript").querySelector("textarea")).toBeNull();
    expect(viewOf("transcript").querySelector("input")).toBeNull();
  });

  test("a FAILED part is named in place — a hole is never silent", () => {
    mount(
      sessionValue({
        chunks: [
          chunk(0, CHUNK_STATE.TRANSCRIBED, "Before the gap."),
          chunk(1, CHUNK_STATE.FAILED, "", 5),
          chunk(2, CHUNK_STATE.TRANSCRIBED, "After the gap."),
        ],
        failed: 1,
      })
    );
    click(tab("transcript"));
    const gap = document.querySelector('[data-listen-in-transcript="gap"]');
    expect(gap).not.toBeNull();
    expect(gap.textContent).toMatch(/could not be transcribed/);
    const body = viewOf("transcript").textContent;
    expect(body.indexOf("Before the gap.")).toBeLessThan(body.indexOf(gap.textContent));
    expect(body.indexOf(gap.textContent)).toBeLessThan(body.indexOf("After the gap."));
  });

  test("a part still being transcribed is shown as PENDING, not as silence", () => {
    mount(
      sessionValue({
        chunks: [chunk(0, CHUNK_STATE.TRANSCRIBED, "Said already."), chunk(1, CHUNK_STATE.TRANSCRIBING)],
        pending: 1,
        summaryCoverage: { pendingCount: 1 },
      })
    );
    click(tab("transcript"));
    const pendingBlock = document.querySelector('[data-listen-in-transcript="pending"]');
    expect(pendingBlock).not.toBeNull();
    expect(pendingBlock.textContent).toMatch(/Transcribing/);
    // No guessed words for it.
    expect(viewOf("transcript").textContent).not.toMatch(/\.\.\.|…\w/);
  });

  test("consecutive speech is grouped into paragraphs rather than one line per chunk", () => {
    const chunks = Array.from({ length: 8 }, (_, i) => chunk(i, CHUNK_STATE.TRANSCRIBED, `Part ${i}.`));
    const blocks = transcriptBlocks(CAPTURE, chunks);
    expect(blocks.length).toBeLessThan(chunks.length);
    mount(sessionValue({ chunks }));
    click(tab("transcript"));
    expect(viewOf("transcript").querySelectorAll("p").length).toBe(blocks.length);
  });

  test("nothing transcribed yet says so, without inventing a transcript", () => {
    mount(
      sessionValue({
        chunks: [],
        transcript: "",
        segments: [],
        summary: summaryRecord({ result: EMPTY_RESULT, final: false }),
      })
    );
    expect(viewOf("transcript").textContent).toMatch(/Nothing has been transcribed yet/);
  });
});

/* ====================== 5. no button-driven summary ====================== */

describe("5. summarisation is automatic — the old actions are gone", () => {
  test("there is no Summarise button anywhere in the window", () => {
    mount(sessionValue());
    expect(byText(/^Summarise$/)).toBeUndefined();
    expect(text()).not.toMatch(/Summarise/);
  });

  test("there is no Insert action of any kind", () => {
    mount(sessionValue());
    expect(text()).not.toMatch(/Insert/);
  });

  test("the actions that remain are the session's own", () => {
    mount(sessionValue());
    expect(byText(/^Copy$/)).toBeDefined();
    expect(byText(/^Export$/)).toBeDefined();
    expect(byText(/^Discard$/)).toBeDefined();
    expect(byText(/^Close$/)).toBeDefined();
  });
});

/* ========================== 6. failure and retry ========================= */

describe("6. a summary failure is reported, and never reads as a lost recording", () => {
  test("the message says the recording is unaffected and offers Try again", () => {
    const value = mount(
      sessionValue({
        summary: summaryRecord({
          lastErrorOutcome: "failure",
          lastErrorMessage:
            "The summary could not be generated. The recording and its transcript are unaffected.",
        }),
      })
    );
    expect(text()).toMatch(/recording and its transcript are unaffected/);
    const retry = byText(/^Try again$/);
    expect(retry).toBeDefined();
    click(retry);
    expect(value.retrySummary).toHaveBeenCalled();
  });

  test("a failure does not remove the summary already generated", () => {
    mount(sessionValue({ summary: summaryRecord({ lastErrorOutcome: "failure" }) }));
    expect(text()).toContain("The team walked the site");
  });

  test("a failure with nothing generated yet still shows the transcript view", () => {
    mount(
      sessionValue({
        summary: summaryRecord({
          result: EMPTY_RESULT,
          final: false,
          status: LISTEN_IN_SUMMARY_STATUS.FAILED,
          lastErrorOutcome: "failure",
        }),
      })
    );
    expect(viewOf("transcript")).not.toBeNull();
    click(tab("summary"));
    expect(document.querySelector("[data-listen-in-summary-status]").textContent).toMatch(
      /could not be generated/
    );
  });
});

/* ============================ 7. summary editing ======================== */

describe("7. the summary may be edited, and regeneration is explicit", () => {
  test("Edit summary opens a draft of the current wording and saves it to the SESSION", () => {
    const value = mount(sessionValue());
    click(byText(/^Edit summary$/));
    const draft = document.querySelector("#listen-in-summary-draft");
    expect(draft).not.toBeNull();
    expect(draft.value).toContain("The team walked the site");
    act(() => {
      draft.value = "What I actually took from it.";
    });
    click(byText(/^Save summary$/));
    expect(value.editSummaryText).toHaveBeenCalledWith("What I actually took from it.");
  });

  test("Cancel leaves the summary exactly as it was", () => {
    const value = mount(sessionValue());
    click(byText(/^Edit summary$/));
    click(byText(/^Cancel$/));
    expect(value.editSummaryText).not.toHaveBeenCalled();
    expect(document.querySelector("#listen-in-summary-draft")).toBeNull();
  });

  test("an edited summary is shown, is labelled as yours, and warns before regeneration", () => {
    mount(
      sessionValue({
        summary: summaryRecord({ userSummaryText: "My own account of the meeting." }),
      })
    );
    expect(text()).toContain("My own account of the meeting.");
    expect(text()).toMatch(/You edited this summary\. Regenerating replaces your wording\./);
    // The generated structured facts are still there underneath.
    expect(text()).toContain("Three boreholes were logged.");
  });

  test("Regenerate is a deliberate action, not something that happens to them", () => {
    const value = mount(sessionValue());
    const regenerate = byText(/^Regenerate$/);
    expect(regenerate).toBeDefined();
    click(regenerate);
    expect(value.regenerateSummary).toHaveBeenCalled();
  });

  test("while a generation is running, Regenerate is busy and cannot be pressed again", () => {
    const value = mount(
      sessionValue({ summary: summaryRecord({ status: LISTEN_IN_SUMMARY_STATUS.GENERATING }) })
    );
    const busy = byText(/^Generating…$/);
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    click(busy);
    expect(value.regenerateSummary).not.toHaveBeenCalled();
  });
});

/* ============================== 8. the header =========================== */

describe("8. the session header carries the state, the clock and the controls", () => {
  test("recording shows Stop recording, Complete meeting, the elapsed time and the state in words", () => {
    const value = mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.RECORDING, legStartedAt: null, capturedMs: 65000 },
        recording: true,
        active: true,
        finished: false,
      })
    );
    expect(byText(/^Stop recording$/)).toBeDefined();
    expect(byText(/^Complete meeting$/)).toBeDefined();
    // Stopping RECORDING is not completing the MEETING: the bare "Stop" of
    // the old window is gone, and this control dispatches `pause`.
    expect(byText(/^Stop$/)).toBeUndefined();
    expect(byText(/^Pause recording$/)).toBeUndefined();
    click(byText(/^Stop recording$/));
    expect(value.pause).toHaveBeenCalled();
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.complete).not.toHaveBeenCalled();
    click(byText(/^Complete meeting$/));
    expect(value.complete).toHaveBeenCalled();
    expect(text()).toContain("1:05");
    expect(text()).toMatch(/Recording…/);
    expect(document.querySelector("[data-listen-in-state]").getAttribute("data-listen-in-state")).toBe(
      "recording"
    );
  });

  test("an interrupted session offers Resume meeting and Complete meeting, and says why", () => {
    const value = mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.INTERRUPTED },
        interrupted: true,
        active: true,
        canResume: true,
        finished: false,
      })
    );
    click(byText(/^Resume meeting$/));
    expect(value.resume).toHaveBeenCalled();
    click(byText(/^Complete meeting$/));
    expect(value.complete).toHaveBeenCalled();
    expect(text()).toMatch(/stopped unexpectedly/);
  });

  test("a STOPPED meeting (internally `paused`) offers Start recording and Complete meeting, with no error banner", () => {
    const value = mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.PAUSED, legStartedAt: null, capturedMs: 65000 },
        paused: true,
        active: true,
        canResume: true,
        finished: false,
      })
    );
    expect(text()).toMatch(/Stopped — start recording again, or complete the meeting\./);
    // The user's own word is "Stopped"; "Paused" is internal and never shown.
    expect(text()).not.toMatch(/Paused/);
    // Stopping is not an interruption: nothing "stopped unexpectedly".
    expect(text()).not.toMatch(/stopped unexpectedly/);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    // The next leg of the SAME meeting starts here — it is not a "resume".
    expect(byText(/^Resume recording$/)).toBeUndefined();
    click(byText(/^Start recording$/));
    expect(value.resume).toHaveBeenCalled();
    click(byText(/^Complete meeting$/));
    expect(value.complete).toHaveBeenCalled();
    // A stopped meeting holds no microphone, so Discard is allowed.
    expect(byText(/^Discard$/).disabled).toBe(false);
  });

  test("a COMPLETING meeting offers only Close", () => {
    mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.FINISHING },
        active: true,
        completing: true,
        finishing: true,
        finished: false,
      })
    );
    expect(byText(/^Close$/)).toBeDefined();
    expect(byText(/^Stop recording$/)).toBeUndefined();
    expect(byText(/^Resume/)).toBeUndefined();
    expect(byText(/^Complete meeting$/)).toBeUndefined();
    expect(byText(/^Start recording$/)).toBeUndefined();
    expect(text()).toMatch(/Completing meeting/);
  });

  test("a COMPLETED meeting is reviewable and offers Start recording for a NEW meeting", () => {
    mount(sessionValue({}));
    expect(byText(/^Start recording$/)).toBeDefined();
    expect(byText(/^Complete meeting$/)).toBeUndefined();
    expect(byText(/^Export$/)).toBeDefined();
    expect(byText(/^Copy$/)).toBeDefined();
    expect(text()).toMatch(/Completed/);
  });

  test("Close says plainly that the recording continues", () => {
    const value = mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.RECORDING },
        recording: true,
        finished: false,
      })
    );
    const close = byText(/^Close$/);
    expect(close.getAttribute("aria-label")).toBe("Close Listen In (recording continues)");
    click(close);
    expect(value.closeWorkspace).toHaveBeenCalled();
    // Closing the view is not stopping the session.
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.discard).not.toHaveBeenCalled();
  });

  test("failed parts keep their own retry, because their audio is kept", () => {
    const value = mount(sessionValue({ failed: 2 }));
    expect(text()).toMatch(/Some of this session could not be transcribed/);
    click(buttons().filter((b) => /^Try again$/.test(b.textContent.trim()))[0]);
    expect(value.retryFailed).toHaveBeenCalled();
  });

  test("Discard is refused while a capture is live", () => {
    mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.RECORDING },
        recording: true,
        finished: false,
      })
    );
    const discard = byText(/^Discard$/);
    expect(discard.disabled).toBe(true);
    expect(discard.getAttribute("title")).toMatch(/Stop recording before discarding/);
  });
});

/* ============================== 9. Copy ================================== */

describe("9. Copy copies the view the user is reading", () => {
  const writeText = jest.fn(async () => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  test("on Summary it copies the summary; on Transcript it copies the transcript", async () => {
    mount(sessionValue());
    await act(async () => {
      byText(/^Copy$/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText.mock.calls[0][0]).toContain("The team walked the site");

    click(tab("transcript"));
    await act(async () => {
      byText(/^Copy$/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText.mock.calls[1][0]).toContain("Right, let us walk the site.");
  });
});
