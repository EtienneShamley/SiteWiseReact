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
    summariseNow: jest.fn(),
    clear: jest.fn(),
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
// ONE PAGE (2026-09-13): the transcript section sits above the Summarised
// section, both always rendered. `viewOf` resolves the two old view names to
// their sections so the content assertions below read unchanged.
const SECTION_OF = { transcript: "transcript", summary: "summarised" };
const viewOf = (name) => document.querySelector(`[data-listen-in-section="${SECTION_OF[name]}"]`);
// The two PAGE sections only — the summary's own headed sub-sections (Key
// points, Decisions, …) carry the same attribute one level down.
const sections = () =>
  [...document.querySelectorAll('[data-listen-in-page="single"] > [data-listen-in-section]')].map((el) => el.getAttribute("data-listen-in-section"));
const text = () => document.body.textContent;

/* ============================ 1. the two views =========================== */

describe("1. ONE page: the transcript on top, the Summarised section directly beneath it", () => {
  test("no view switcher of any kind renders — no Original/Summarised, no Summary/Transcript tabs", () => {
    mount(sessionValue());
    expect(document.querySelector('[role="group"][aria-label="Listen In view"]')).toBeNull();
    expect(document.querySelector("[data-listen-in-tab]")).toBeNull();
    expect(document.querySelector("[aria-pressed]:not([data-listen-in-control])")).toBeNull();
    for (const b of buttons()) expect(b.textContent.trim()).not.toMatch(/^(Original|Summarised|Summary|Transcript)$/);
  });

  test("both sections render on the same page, transcript first, inside one scrolling body", () => {
    mount(sessionValue());
    expect(sections()).toEqual(["transcript", "summarised"]);
    const page = document.querySelector('[data-listen-in-page="single"]');
    expect(page).not.toBeNull();
    expect(page.contains(viewOf("transcript"))).toBe(true);
    expect(page.contains(viewOf("summary"))).toBe(true);
    // The transcript precedes the summary in document order.
    expect(viewOf("transcript").compareDocumentPosition(viewOf("summary")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(viewOf("transcript").textContent).toContain("Right, let us walk the site.");
    expect(viewOf("summary").textContent).toContain("The team walked the site");
  });

  test("each section is headed, and the headings say what they are", () => {
    mount(sessionValue());
    expect(viewOf("transcript").querySelector("h3").textContent.trim()).toBe("Original transcript");
    expect(viewOf("summary").querySelector("h3").textContent.trim()).toBe("Summarised");
  });

  test("1/2/3/4/5. with nothing summarised yet the page is the transcript and ONE Summarise button — no Summarised section, no placeholder", () => {
    mount(sessionValue({ summary: summaryRecord({ result: EMPTY_RESULT, final: false, revision: 0 }) }));
    expect(sections()).toEqual(["transcript"]);
    expect(viewOf("summary")).toBeNull();
    expect(viewOf("transcript").textContent).toContain("Right, let us walk the site.");
    const summarise = byText(/^Summarise$/);
    expect(summarise).toBeDefined();
    // The button sits UNDER the transcript, inside the same scrolling page.
    const page = document.querySelector('[data-listen-in-page="single"]');
    expect(page.contains(summarise)).toBe(true);
    expect(viewOf("transcript").compareDocumentPosition(summarise) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No automatic-summary messaging of any kind.
    expect(text()).not.toMatch(/Nothing has been summarised|summary appears|Listening —|Waiting for enough|builds itself|Summarised/);
    expect(document.querySelector("[data-listen-in-summary-status]")).toBeNull();
  });

  test("while the user's request is in flight the button reads Summarising… and there is still no Summarised section", () => {
    mount(sessionValue({ summary: summaryRecord({ result: EMPTY_RESULT, final: false, revision: 0, status: LISTEN_IN_SUMMARY_STATUS.GENERATING }) }));
    expect(sections()).toEqual(["transcript"]);
    const busy = byText(/^Summarising…$/);
    expect(busy).toBeDefined();
    expect(busy.disabled).toBe(true);
    expect(viewOf("transcript").textContent).toContain("Right, let us walk the site.");
  });

  test("the generated summary appears underneath the transcript, structured, on the same page", () => {
    mount(sessionValue());
    const summary = viewOf("summary");
    expect(summary.textContent).toContain("Costs were reviewed.");
    expect(summary.querySelector('[data-listen-in-section="Key points"]')).not.toBeNull();
    expect(summary.querySelector("textarea")).toBeNull();
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
      "Summary of the whole transcript."
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
      /does not cover the newest transcript\. Summarise again to include it\./
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

  test("before the first transcript there is no Summarise button, no Summarised section and no waiting message", () => {
    mount(
      sessionValue({
        chunks: [chunk(0, CHUNK_STATE.SEALED)],
        summary: summaryRecord({ result: EMPTY_RESULT, final: false, coveredThroughSeq: -1 }),
        summaryCoverage: { pendingCount: 1, transcribedThroughSeq: -1, summaryThroughSeq: -1, complete: false },
      })
    );
    expect(sections()).toEqual(["transcript"]);
    expect(byText(/^Summarise$/)).toBeUndefined();
    expect(text()).not.toMatch(/Waiting for enough|Listening —|summary appears/);
    expect(text()).toMatch(/Transcribing this part/);
  });
});

/* ============================= 4. the transcript ========================= */

describe("4. the transcript is read-first, complete and in order", () => {
  test("it renders the canonical ordered segments with elapsed offsets", () => {
    mount(sessionValue());
    const body = viewOf("transcript").textContent;
    expect(body.indexOf("Right, let us walk the site.")).toBeLessThan(
      body.indexOf("Agreed, we will move the survey.")
    );
    // Offsets are relative to the session, not a wall clock.
    expect(body).toContain("0:00");
  });

  test("it is NOT an editable textarea", () => {
    mount(sessionValue());
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

/* ============ 5. explicit Summarise beside the automatic loop =========== */

describe("5. summarisation is automatic AND explicit (2026-09-13)", () => {
  test("6. with transcript and no summary yet, the Summarised view offers [Summarise]", () => {
    const value = mount(sessionValue({ summary: summaryRecord({ result: EMPTY_RESULT, final: false, revision: 0 }) }));
    const summarise = byText(/^Summarise$/);
    expect(summarise).toBeDefined();
    expect(byText(/^Summarise again$/)).toBeUndefined();
    expect(viewOf("summary")).toBeNull();
    click(summarise);
    expect(value.summariseNow).toHaveBeenCalledTimes(1);
    // The old vocabulary is gone: no Regenerate, no bare Try again for the summary.
    expect(byText(/^Regenerate$/)).toBeUndefined();
  });

  test("9. once a summary exists the control reads [Summarise again], and it is the same intent", () => {
    const value = mount(sessionValue());
    const again = byText(/^Summarise again$/);
    expect(again).toBeDefined();
    expect(byText(/^Summarise$/)).toBeUndefined();
    click(again);
    expect(value.summariseNow).toHaveBeenCalledTimes(1);
    expect(value.regenerateSummary).not.toHaveBeenCalled();
    expect(value.retrySummary).not.toHaveBeenCalled();
  });

  test("with no transcribed words there is nothing to summarise, so no control is offered", () => {
    mount(
      sessionValue({
        chunks: [chunk(0, CHUNK_STATE.SEALED)],
        summary: summaryRecord({ result: EMPTY_RESULT, final: false, revision: 0 }),
        summaryCoverage: { pendingCount: 1, transcribedThroughSeq: -1, summaryThroughSeq: -1, complete: false },
      })
    );
    expect(byText(/^Summarise$/)).toBeUndefined();
    expect(byText(/^Summarise again$/)).toBeUndefined();
  });

  test("the control never touches the microphone or the meeting: it dispatches one intent and nothing else", () => {
    const value = mount(sessionValue());
    click(byText(/^Summarise again$/));
    expect(value.start).not.toHaveBeenCalled();
    expect(value.resume).not.toHaveBeenCalled();
    expect(value.pause).not.toHaveBeenCalled();
    expect(value.complete).not.toHaveBeenCalled();
    expect(value.discard).not.toHaveBeenCalled();
  });

  test("there is no Insert action of any kind", () => {
    mount(sessionValue());
    expect(text()).not.toMatch(/Insert/);
  });

  test("the actions that remain are the session's own — and a COMPLETED meeting is left with Clear, not Discard", () => {
    const value = mount(sessionValue());
    // Copy is named per section, beside what it copies; there is no bare Copy.
    expect(byText(/^Copy transcript$/)).toBeDefined();
    expect(byText(/^Copy summary$/)).toBeDefined();
    expect(byText(/^Copy$/)).toBeUndefined();
    expect(byText(/^Export$/)).toBeDefined();
    expect(byText(/^Close$/)).toBeDefined();
    const clear = byText(/^Clear$/);
    expect(clear).toBeDefined();
    expect(byText(/^Discard$/)).toBeUndefined();
    click(clear);
    expect(value.clear).toHaveBeenCalledTimes(1);
    expect(value.discard).not.toHaveBeenCalled();
  });

  test("an UNFINISHED meeting keeps its destructive Discard and is offered no Clear", () => {
    mount(
      sessionValue({
        session: { ...CAPTURE, state: LISTEN_IN_STATE.PAUSED },
        active: true,
        paused: true,
        finished: false,
        canResume: true,
      })
    );
    expect(byText(/^Discard$/)).toBeDefined();
    expect(byText(/^Clear$/)).toBeUndefined();
  });
});

/* ========================== 6. failure and retry ========================= */

describe("6. a summary failure is reported, and never reads as a lost recording", () => {
  test("10. the message says the recording is unaffected and offers [Try summarising again] — never a bare Try again", () => {
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
    const retry = byText(/^Try summarising again$/);
    expect(retry).toBeDefined();
    expect(byText(/^Try again$/)).toBeUndefined();
    click(retry);
    expect(value.summariseNow).toHaveBeenCalledTimes(1);
    // 11/12: the retry reopens nothing and creates nothing.
    expect(value.start).not.toHaveBeenCalled();
    expect(value.resume).not.toHaveBeenCalled();
  });

  test("a failed meeting with NO summary yet still keeps its Original and offers the retry", () => {
    const value = mount(
      sessionValue({
        summary: summaryRecord({
          status: LISTEN_IN_SUMMARY_STATUS.FAILED,
          result: EMPTY_RESULT,
          final: false,
          revision: 0,
          lastErrorOutcome: "failure",
          lastErrorMessage: "The summary could not be generated. The recording and its transcript are unaffected.",
        }),
      })
    );
    // The Original is intact and readable.
    expect(text()).toContain("Right, let us walk the site.");
    expect(text()).toMatch(/The summary could not be generated\./);
    click(byText(/^Try summarising again$/));
    expect(value.summariseNow).toHaveBeenCalledTimes(1);
  });

  test("a failure does not remove the summary already generated", () => {
    mount(sessionValue({ summary: summaryRecord({ lastErrorOutcome: "failure" }) }));
    expect(text()).toContain("The team walked the site");
  });

  test("17/18/19. a failed request with nothing generated keeps the transcript visible, states the failure BENEATH it with Try summarising again, and shows no empty Summarised section", () => {
    const value = mount(
      sessionValue({
        summary: summaryRecord({
          result: EMPTY_RESULT,
          final: false,
          revision: 0,
          status: LISTEN_IN_SUMMARY_STATUS.FAILED,
          lastErrorOutcome: "failure",
          lastErrorMessage: "The summary could not be generated. The recording and its transcript are unaffected.",
        }),
      })
    );
    expect(sections()).toEqual(["transcript"]);
    expect(viewOf("summary")).toBeNull();
    expect(viewOf("transcript").textContent).toContain("Right, let us walk the site.");
    const failure = document.querySelector('[data-listen-in-summary="failed"]');
    expect(failure).not.toBeNull();
    expect(failure.textContent).toMatch(/could not be generated/);
    expect(viewOf("transcript").compareDocumentPosition(failure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const retry = byText(/^Try summarising again$/);
    expect(retry).toBeDefined();
    click(retry);
    expect(value.summariseNow).toHaveBeenCalledTimes(1);
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

  test("Summarise again is a deliberate action, not something that happens to them, and it warns before replacing their words", () => {
    const value = mount(sessionValue({ summary: summaryRecord({ userSummaryText: "My own account of the meeting." }) }));
    const again = byText(/^Summarise again$/);
    expect(again).toBeDefined();
    expect(again.getAttribute("title")).toMatch(/replacing your edited wording/);
    click(again);
    expect(value.summariseNow).toHaveBeenCalledTimes(1);
  });

  test("while a generation is running the control is busy and cannot be pressed again", () => {
    const value = mount(
      sessionValue({ summary: summaryRecord({ status: LISTEN_IN_SUMMARY_STATUS.GENERATING }) })
    );
    const busy = byText(/^Summarising…$/);
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    click(busy);
    expect(value.summariseNow).not.toHaveBeenCalled();
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
    expect(byText(/^Copy transcript$/)).toBeDefined();
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

describe("9. Copy is named for what it copies — Copy transcript beside the transcript, Copy summary beside the summary", () => {
  const writeText = jest.fn(async () => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  test("13/14. Copy summary copies the summary; Copy transcript copies the whole transcript; each sits inside its own section", async () => {
    mount(sessionValue());
    const copySummary = byText(/^Copy summary$/);
    const copyTranscript = byText(/^Copy transcript$/);
    expect(viewOf("summary").contains(copySummary)).toBe(true);
    expect(viewOf("transcript").contains(copyTranscript)).toBe(true);
    await act(async () => {
      copySummary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText.mock.calls[0][0]).toContain("The team walked the site");
    expect(writeText.mock.calls[0][0]).not.toContain("Right, let us walk the site.");
    expect(text()).toMatch(/Summary copied\./);
    await act(async () => {
      copyTranscript.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText.mock.calls[1][0]).toContain("Right, let us walk the site.");
    expect(writeText.mock.calls[1][0]).toContain("Agreed, we will move the survey.");
    expect(writeText.mock.calls[1][0]).not.toContain("The team walked the site");
    expect(text()).toMatch(/Transcript copied\./);
  });

  test("with no summary there is no Copy summary, and Copy transcript is still there", () => {
    mount(sessionValue({ summary: summaryRecord({ result: EMPTY_RESULT, final: false, revision: 0 }) }));
    expect(byText(/^Copy summary$/)).toBeUndefined();
    expect(byText(/^Copy transcript$/)).toBeDefined();
  });
});
