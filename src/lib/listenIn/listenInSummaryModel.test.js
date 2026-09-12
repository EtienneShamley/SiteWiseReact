// src/lib/listenIn/listenInSummaryModel.test.js
//
// THE SUMMARY MODEL (Phase 8D.2) — windows, coverage and the reduce, proved
// without a network, a model or a clock.
//
// The properties this file exists to hold:
//   - a window is only ever taken from SETTLED transcript, so the summary can
//     never read past a chunk whose words have not arrived;
//   - a window must be WORTH a request, so a 30-second chunk never costs one;
//   - coverage is stated, so the window can say what the summary does and does
//     not include, and "complete" is never claimed while it is not;
//   - the interim reduce is deterministic and invents nothing;
//   - a user's own wording is never overwritten by a generation.

import { CHUNK_STATE, LISTEN_IN_STATE } from "./listenInModel";
import {
  LISTEN_IN_SUMMARY_POLICY,
  LISTEN_IN_SUMMARY_STATUS,
  appendSummaryPart,
  canAttemptSummary,
  createSessionSummary,
  hasSummaryToShow,
  hasUnsummarisedTranscript,
  hasUserEditedSummary,
  isChunkSettledForSummary,
  listenInActionItemId,
  listenInCoverageNote,
  listenInFinishedWithIssues,
  listenInSummaryCoverage,
  listenInSummaryStatusLabel,
  mergeSummaryResults,
  nextSummaryWindow,
  rewindSummaryCoverage,
  settledThroughSeq,
  summaryDisplayText,
  summaryMergeGroups,
  summaryRequestStarted,
  summaryRetryRequested,
  withFinalSummary,
  withSummaryFailure,
  withUserSummaryText,
} from "./listenInSummaryModel";

const IDS = { uid: "uid-1", workspaceId: "ws-1", sessionId: "s-1" };
const fresh = (now = 1000) => createSessionSummary({ ...IDS, now });

/** A chunk row, as the engine stores one. */
function chunk(seq, state, text = "", attempts = 0) {
  return { seq, state, text, attempts, startedAt: 1000 + seq * 30000, endedAt: 1000 + (seq + 1) * 30000 };
}
const said = (seq, text) => chunk(seq, CHUNK_STATE.TRANSCRIBED, text);
const silent = (seq) => chunk(seq, CHUNK_STATE.EMPTY);
const pending = (seq) => chunk(seq, CHUNK_STATE.SEALED);
const inFlight = (seq) => chunk(seq, CHUNK_STATE.TRANSCRIBING);
const dead = (seq) => chunk(seq, CHUNK_STATE.FAILED, "", 5);
const retrying = (seq) => chunk(seq, CHUNK_STATE.FAILED, "", 1);

/** Enough words to clear the size gate. */
const lots = (n = 1) => "word ".repeat(700 * n).trim();

const result = (text, extra = {}) => ({
  summaryText: text,
  keyPoints: [],
  decisions: [],
  actionItems: [],
  risks: [],
  followUps: [],
  ...extra,
});

const MAX = 5; // the drain's attempt ceiling, as the engine passes it

/* ============================ settled transcript ========================= */

describe("only SETTLED transcript may be summarised", () => {
  test.each([
    ["transcribed", said(0, "x"), true],
    ["empty (silence)", silent(0), true],
    ["failed with attempts exhausted", dead(0), true],
    ["sealed", pending(0), false],
    ["in flight", inFlight(0), false],
    ["failed but still retrying", retrying(0), false],
  ])("%s is settled: %s", (_label, row, expected) => {
    expect(isChunkSettledForSummary(row, { maxAttempts: MAX })).toBe(expected);
  });

  test("coverage stops at the FIRST unsettled chunk, however much follows it", () => {
    // 0 and 1 are done, 2 is still transcribing, 3 arrived early. Reading past
    // 2 would put chunk 3's words before chunk 2's in the summary.
    const chunks = [said(0, "a"), said(1, "b"), inFlight(2), said(3, "d")];
    expect(settledThroughSeq(chunks, { maxAttempts: MAX })).toBe(1);
  });

  test("nothing at all is settled while the first chunk is still in flight", () => {
    expect(settledThroughSeq([inFlight(0), said(1, "b")], { maxAttempts: MAX })).toBe(-1);
    expect(settledThroughSeq([], { maxAttempts: MAX })).toBe(-1);
  });
});

/* =============================== windows ================================= */

describe("a window must be worth a request", () => {
  test("ONE 30-second chunk does not trigger a summary", () => {
    const window = nextSummaryWindow({
      chunks: [said(0, "Just a sentence or two of speech.")],
      summary: fresh(),
      now: 999999,
      maxAttempts: MAX,
    });
    expect(window).toBeNull();
  });

  test("enough transcript does", () => {
    const window = nextSummaryWindow({
      chunks: [said(0, lots()), said(1, lots())],
      summary: fresh(),
      now: 999999,
      maxAttempts: MAX,
    });
    expect(window).not.toBeNull();
    expect(window.segments.map((s) => s.seq)).toEqual([0, 1]);
    expect(window.chars).toBeGreaterThanOrEqual(LISTEN_IN_SUMMARY_POLICY.minWindowChars);
  });

  test("a second window waits for the interval, however fast the words arrive", () => {
    const summary = summaryRequestStarted(fresh(), { now: 10000 });
    const chunks = [said(0, lots()), said(1, lots()), said(2, lots())];
    const tooSoon = nextSummaryWindow({ chunks, summary, now: 20000, maxAttempts: MAX });
    expect(tooSoon).toBeNull();
    const later = nextSummaryWindow({
      chunks,
      summary,
      now: 10000 + LISTEN_IN_SUMMARY_POLICY.minIntervalMs + 1,
      maxAttempts: MAX,
    });
    expect(later).not.toBeNull();
  });

  test("FINALISATION ignores both gates — the last ninety seconds still count", () => {
    const summary = summaryRequestStarted(fresh(), { now: 10000 });
    const window = nextSummaryWindow({
      chunks: [said(0, "One last thing before we go.")],
      summary,
      force: true,
      now: 10001,
      maxAttempts: MAX,
    });
    expect(window).not.toBeNull();
    expect(window.segments).toHaveLength(1);
  });

  test("a backlog is split into BOUNDED windows rather than one oversized request", () => {
    // Twelve very long chunks: far more than one window may carry.
    const chunks = Array.from({ length: 12 }, (_, i) => said(i, "z".repeat(4000)));
    const first = nextSummaryWindow({ chunks, summary: fresh(), now: 999999, maxAttempts: MAX });
    expect(first.chars).toBeLessThanOrEqual(LISTEN_IN_SUMMARY_POLICY.maxWindowChars);
    expect(first.toSeq).toBeLessThan(11);
    // The next pass picks up exactly where it left off — nothing repeated,
    // nothing skipped.
    const after = appendSummaryPart(fresh(), {
      part: result("first part"),
      fromSeq: first.fromSeq,
      toSeq: first.toSeq,
      now: 2000,
    });
    const second = nextSummaryWindow({ chunks, summary: after, force: true, now: 999999, maxAttempts: MAX });
    expect(second.fromSeq).toBe(first.toSeq + 1);
  });

  test("a single chunk longer than the ceiling still makes progress rather than stalling", () => {
    const chunks = [said(0, "y".repeat(LISTEN_IN_SUMMARY_POLICY.maxWindowChars + 5000))];
    const window = nextSummaryWindow({ chunks, summary: fresh(), now: 999999, maxAttempts: MAX });
    expect(window).not.toBeNull();
    expect(window.segments).toHaveLength(1);
  });

  test("a window never reaches past a chunk still being transcribed", () => {
    const chunks = [said(0, lots()), said(1, lots()), inFlight(2), said(3, lots())];
    const window = nextSummaryWindow({ chunks, summary: fresh(), now: 999999, maxAttempts: MAX });
    expect(window.toSeq).toBe(1);
    expect(window.segments.map((s) => s.seq)).toEqual([0, 1]);
  });

  test("SILENCE costs nothing: it advances coverage and is never sent", () => {
    const chunks = [silent(0), silent(1), dead(2)];
    const window = nextSummaryWindow({ chunks, summary: fresh(), now: 999999, maxAttempts: MAX });
    expect(window.silent).toBe(true);
    expect(window.segments).toEqual([]);
    expect(window.toSeq).toBe(2);
  });

  test("there is no window when everything settled has already been read", () => {
    const summary = appendSummaryPart(fresh(), {
      part: result("done"),
      fromSeq: 0,
      toSeq: 1,
      now: 2000,
    });
    const chunks = [said(0, lots()), said(1, lots())];
    expect(nextSummaryWindow({ chunks, summary, force: true, now: 999999, maxAttempts: MAX })).toBeNull();
    expect(hasUnsummarisedTranscript({ chunks, summary, maxAttempts: MAX })).toBe(false);
    expect(
      hasUnsummarisedTranscript({ chunks: [...chunks, said(2, "more")], summary, maxAttempts: MAX })
    ).toBe(true);
  });
});

/* ============================== the reduce =============================== */

describe("the interim reduce is deterministic and invents nothing", () => {
  test("one part is itself", () => {
    expect(mergeSummaryResults([result("only")])).toMatchObject({ summaryText: "only" });
  });

  test("overviews are joined in order and lists are deduplicated", () => {
    const merged = mergeSummaryResults([
      result("First half.", { keyPoints: ["Same point", "One"] }),
      result("Second half.", { keyPoints: ["same point.", "Two"] }),
    ]);
    expect(merged.summaryText).toBe("First half.\n\nSecond half.");
    expect(merged.keyPoints).toEqual(["Same point", "One", "Two"]);
  });

  test("the same task said twice becomes one item, and a STATED owner fills a null", () => {
    const merged = mergeSummaryResults([
      result("a", { actionItems: [{ task: "Send the logs", owner: null, dueDate: null, sourceSeq: 1 }] }),
      result("b", {
        actionItems: [{ task: "send the logs.", owner: "Priya", dueDate: "Friday", sourceSeq: 9 }],
      }),
    ]);
    expect(merged.actionItems).toEqual([
      { task: "Send the logs", owner: "Priya", dueDate: "Friday", sourceSeq: 1 },
    ]);
  });

  test("a null owner is never filled from nothing", () => {
    const merged = mergeSummaryResults([
      result("a", { actionItems: [{ task: "Book the rig", owner: null, dueDate: null, sourceSeq: null }] }),
      result("b", { actionItems: [{ task: "Book the rig", owner: null, dueDate: null, sourceSeq: null }] }),
    ]);
    expect(merged.actionItems).toEqual([
      { task: "Book the rig", owner: null, dueDate: null, sourceSeq: null },
    ]);
  });

  test("empty parts contribute nothing", () => {
    expect(mergeSummaryResults([]).summaryText).toBe("");
    expect(mergeSummaryResults([result(""), null]).summaryText).toBe("");
  });

  test("a long meeting reduces in BOUNDED GROUPS, never in one call", () => {
    const parts = Array.from({ length: 30 }, (_, i) => result(`p${i}`));
    const groups = summaryMergeGroups(parts, 12);
    expect(groups.map((g) => g.length)).toEqual([12, 12, 6]);
    expect(groups.flat()).toHaveLength(30);
  });
});

/* ============================== transitions ============================== */

describe("appending a part", () => {
  test("advances coverage, bumps the revision and becomes readable", () => {
    const summary = appendSummaryPart(fresh(), {
      part: result("what happened"),
      fromSeq: 0,
      toSeq: 3,
      now: 5000,
    });
    expect(summary.coveredThroughSeq).toBe(3);
    expect(summary.revision).toBe(1);
    expect(summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.READY);
    expect(summary.parts).toHaveLength(1);
    expect(hasSummaryToShow(summary)).toBe(true);
  });

  test("a SILENT window advances coverage without a part or a revision", () => {
    const summary = appendSummaryPart(fresh(), {
      part: null,
      fromSeq: 0,
      toSeq: 2,
      missingSeqs: [2],
      now: 5000,
    });
    expect(summary.coveredThroughSeq).toBe(2);
    expect(summary.parts).toHaveLength(0);
    expect(summary.revision).toBe(0);
    expect(summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.IDLE);
    expect(summary.missingSeqs).toEqual([2]);
  });

  test("missing sequences accumulate, sorted and deduplicated", () => {
    let summary = appendSummaryPart(fresh(), { part: null, fromSeq: 0, toSeq: 1, missingSeqs: [1], now: 1 });
    summary = appendSummaryPart(summary, { part: null, fromSeq: 2, toSeq: 4, missingSeqs: [4, 1], now: 2 });
    expect(summary.missingSeqs).toEqual([1, 4]);
  });

  test("any progress clears a previous failure", () => {
    const failed = withSummaryFailure(fresh(), { outcome: "failure", now: 1000 });
    expect(failed.attempts).toBe(1);
    const recovered = appendSummaryPart(failed, { part: result("ok"), fromSeq: 0, toSeq: 1, now: 2000 });
    expect(recovered.attempts).toBe(0);
    expect(recovered.lastErrorOutcome).toBeNull();
  });
});

describe("failure never costs the recording anything", () => {
  test("a failure with no summary yet is FAILED and retriable", () => {
    const failed = withSummaryFailure(fresh(), { outcome: "failure", message: "nope", now: 1000 });
    expect(failed.status).toBe(LISTEN_IN_SUMMARY_STATUS.FAILED);
    expect(failed.lastErrorMessage).toBe("nope");
    expect(failed.nextAttemptAt).toBeGreaterThan(1000);
  });

  test("a failure with a summary already on screen KEEPS showing it", () => {
    const ready = appendSummaryPart(fresh(), { part: result("so far"), fromSeq: 0, toSeq: 1, now: 1000 });
    const failed = withSummaryFailure(ready, { outcome: "failure", now: 2000 });
    expect(failed.status).toBe(LISTEN_IN_SUMMARY_STATUS.READY);
    expect(summaryDisplayText(failed)).toBe("so far");
  });

  test("the backoff grows and then gives up until an explicit retry", () => {
    let summary = fresh();
    const gaps = [];
    for (let i = 0; i < LISTEN_IN_SUMMARY_POLICY.maxAutoAttempts; i += 1) {
      summary = withSummaryFailure(summary, { outcome: "failure", now: 1000 });
      gaps.push(summary.nextAttemptAt - 1000);
    }
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(canAttemptSummary(summary, { now: 999999999 })).toBe(false);
    // An explicit Try again clears both the count and the gate.
    const retried = summaryRetryRequested(summary, { now: 2000 });
    expect(canAttemptSummary(retried, { now: 2000 })).toBe(true);
    expect(retried.lastErrorOutcome).toBeNull();
  });

  test("the backoff gate holds until its time", () => {
    const failed = withSummaryFailure(fresh(), { outcome: "failure", now: 1000 });
    expect(canAttemptSummary(failed, { now: 1001 })).toBe(false);
    expect(canAttemptSummary(failed, { now: failed.nextAttemptAt })).toBe(true);
  });
});

/* ============================== user editing ============================= */

describe("a person's own wording is never overwritten by a generation", () => {
  test("an edit wins wherever the summary is read", () => {
    const ready = appendSummaryPart(fresh(), { part: result("generated"), fromSeq: 0, toSeq: 1, now: 1 });
    const edited = withUserSummaryText(ready, "  What I actually took from it.  ", { now: 2 });
    expect(hasUserEditedSummary(edited)).toBe(true);
    expect(summaryDisplayText(edited)).toBe("What I actually took from it.");
    // The generated result underneath is untouched.
    expect(edited.result.summaryText).toBe("generated");
  });

  test("a later window updates the FACTS without touching the person's words", () => {
    let summary = appendSummaryPart(fresh(), { part: result("generated"), fromSeq: 0, toSeq: 1, now: 1 });
    summary = withUserSummaryText(summary, "Mine.", { now: 2 });
    summary = appendSummaryPart(summary, {
      part: result("more", { decisions: ["We go on Friday."] }),
      fromSeq: 2,
      toSeq: 3,
      now: 3,
    });
    expect(summaryDisplayText(summary)).toBe("Mine.");
    expect(summary.result.decisions).toEqual(["We go on Friday."]);
  });

  test("clearing the edit gives the generated overview back", () => {
    let summary = appendSummaryPart(fresh(), { part: result("generated"), fromSeq: 0, toSeq: 1, now: 1 });
    summary = withUserSummaryText(summary, "Mine.", { now: 2 });
    summary = withUserSummaryText(summary, "   ", { now: 3 });
    expect(hasUserEditedSummary(summary)).toBe(false);
    expect(summaryDisplayText(summary)).toBe("generated");
  });

  test("an edited summary is showable even with nothing generated", () => {
    expect(hasSummaryToShow(withUserSummaryText(fresh(), "Mine.", { now: 1 }))).toBe(true);
    expect(hasSummaryToShow(fresh())).toBe(false);
    expect(hasSummaryToShow(null)).toBe(false);
  });
});

/* =============================== coverage ================================ */

describe("coverage is stated, never implied", () => {
  const session = (state) => ({ state, startedAt: 1000 });

  test("it reports what is transcribed, what is summarised and what is in flight", () => {
    const summary = appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 1, now: 1 });
    const chunks = [said(0, "a"), said(1, "b"), pending(2), pending(3)];
    const coverage = listenInSummaryCoverage(session(LISTEN_IN_STATE.RECORDING), chunks, summary, {
      maxAttempts: MAX,
    });
    expect(coverage).toMatchObject({
      transcribedThroughSeq: 1,
      summaryThroughSeq: 1,
      pendingCount: 2,
      behind: false,
      capturing: true,
      complete: false,
    });
  });

  test("a summary BEHIND the transcript says so", () => {
    const chunks = [said(0, "a"), said(1, "b"), said(2, "c")];
    const summary = appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 0, now: 1 });
    const coverage = listenInSummaryCoverage(session(LISTEN_IN_STATE.RECORDING), chunks, summary, {
      maxAttempts: MAX,
    });
    expect(coverage.behind).toBe(true);
    expect(coverage.complete).toBe(false);
  });

  test("COMPLETE requires a finished session, a final summary and nothing outstanding", () => {
    const chunks = [said(0, "a"), said(1, "b")];
    let summary = appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 1, now: 1 });
    // Finished session, but the summary has not been consolidated yet.
    expect(
      listenInSummaryCoverage(session(LISTEN_IN_STATE.FINISHED), chunks, summary, { maxAttempts: MAX })
        .complete
    ).toBe(false);
    summary = withFinalSummary(summary, { result: result("final"), now: 2 });
    expect(
      listenInSummaryCoverage(session(LISTEN_IN_STATE.FINISHED), chunks, summary, { maxAttempts: MAX })
        .complete
    ).toBe(true);
    // Still capturing: never complete, however final the summary claims to be.
    expect(
      listenInSummaryCoverage(session(LISTEN_IN_STATE.RECORDING), chunks, summary, { maxAttempts: MAX })
        .complete
    ).toBe(false);
  });

  test("a permanently failed chunk is counted and does not block completeness", () => {
    const chunks = [said(0, "a"), dead(1), said(2, "c")];
    const summary = withFinalSummary(
      appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 2, missingSeqs: [1], now: 1 }),
      { result: result("final"), now: 2 }
    );
    const coverage = listenInSummaryCoverage(session(LISTEN_IN_STATE.FINISHED), chunks, summary, {
      maxAttempts: MAX,
    });
    expect(coverage.failedCount).toBe(1);
    expect(coverage.complete).toBe(true);
    // …and the document says so rather than reading as a whole record.
    expect(listenInCoverageNote(coverage)).toMatch(/does not cover the whole recording/);
    expect(listenInCoverageNote(coverage)).toMatch(/One part of the recording could not be transcribed/);
  });

  test("a whole recording carries no coverage note at all", () => {
    const chunks = [said(0, "a")];
    const summary = withFinalSummary(
      appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 0, now: 1 }),
      { result: result("final"), now: 2 }
    );
    const coverage = listenInSummaryCoverage(session(LISTEN_IN_STATE.FINISHED), chunks, summary, {
      maxAttempts: MAX,
    });
    expect(listenInCoverageNote(coverage)).toBe("");
  });

  test("FINISHED WITH ISSUES is a real, reportable state", () => {
    expect(listenInFinishedWithIssues(session(LISTEN_IN_STATE.FINISHED), [said(0, "a"), dead(1)])).toBe(true);
    expect(listenInFinishedWithIssues(session(LISTEN_IN_STATE.FINISHED), [said(0, "a")])).toBe(false);
    expect(listenInFinishedWithIssues(session(LISTEN_IN_STATE.RECORDING), [dead(1)])).toBe(false);
  });
});

/* ============================== the wording ============================== */

describe("the status sentence never claims more than is true", () => {
  const cov = (over = {}) => ({
    pendingCount: 0,
    failedCount: 0,
    behind: false,
    capturing: false,
    ...over,
  });

  test("generating, before and after there is anything to show", () => {
    expect(listenInSummaryStatusLabel(summaryRequestStarted(fresh(), { now: 1 }), cov())).toMatch(
      /Generating the summary/
    );
    const withPart = appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 0, now: 1 });
    expect(listenInSummaryStatusLabel(summaryRequestStarted(withPart, { now: 2 }), cov())).toMatch(
      /Updating the summary/
    );
  });

  test("an in-progress summary says so, and says when it is behind", () => {
    const summary = appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 0, now: 1 });
    expect(listenInSummaryStatusLabel(summary, cov({ capturing: true }))).toMatch(
      /in progress — it covers the meeting so far/
    );
    expect(listenInSummaryStatusLabel(summary, cov({ behind: true, capturing: true }))).toMatch(
      /does not yet cover the whole meeting/
    );
    expect(listenInSummaryStatusLabel(summary, cov())).toMatch(/finalising/);
  });

  test("a final summary over an incomplete recording names the gap", () => {
    const summary = withFinalSummary(
      appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 0, now: 1 }),
      { result: result("final"), now: 2 }
    );
    expect(listenInSummaryStatusLabel(summary, cov())).toBe("Final summary.");
    expect(listenInSummaryStatusLabel(summary, cov({ failedCount: 2 }))).toMatch(
      /2 parts of the recording could not be transcribed/
    );
  });

  test("a failure is reported without the summary disappearing from the sentence", () => {
    const ready = appendSummaryPart(fresh(), { part: result("a"), fromSeq: 0, toSeq: 0, now: 1 });
    const failed = withSummaryFailure(ready, { outcome: "failure", now: 2 });
    expect(listenInSummaryStatusLabel(failed, cov())).toMatch(/what was generated before that/);
  });

  test("nothing yet says what it is waiting for", () => {
    expect(listenInSummaryStatusLabel(fresh(), cov({ pendingCount: 2 }))).toMatch(
      /Waiting for enough transcript/
    );
    expect(listenInSummaryStatusLabel(fresh(), cov({ capturing: true }))).toMatch(/Listening/);
    expect(listenInSummaryStatusLabel(null, cov())).toBe("");
  });
});

/* ============================ action item ids ============================ */

describe("an action item keeps a stable identity for a future NoteWise task", () => {
  test("the same item produces the same id across regenerations", () => {
    const item = { task: "Send the borehole logs", owner: "Priya", dueDate: "Friday", sourceSeq: 4 };
    const id = listenInActionItemId("s-1", item);
    expect(listenInActionItemId("s-1", { ...item, owner: null })).toBe(id);
    expect(id).toContain("s-1");
    expect(id).toContain("send-the-borehole-logs");
  });

  test("different sessions, sequences and tasks are different items", () => {
    const item = { task: "Send the logs", sourceSeq: 4 };
    expect(listenInActionItemId("s-1", item)).not.toBe(listenInActionItemId("s-2", item));
    expect(listenInActionItemId("s-1", item)).not.toBe(
      listenInActionItemId("s-1", { ...item, sourceSeq: 5 })
    );
    expect(listenInActionItemId("s-1", item)).not.toBe(
      listenInActionItemId("s-1", { task: "Book the rig", sourceSeq: 4 })
    );
  });

  test("an item with no provenance still gets an id", () => {
    expect(listenInActionItemId("s-1", { task: "Do the thing", sourceSeq: null })).toBe(
      "s-1:x:do-the-thing"
    );
  });
});

/* ===================== filling a hole a retry recovered ================== */

describe("rewinding coverage so a filled hole reaches the summary (8D.3)", () => {
  test("a retried sequence is re-read: the parts past it go, the ones before stay", () => {
    let summary = appendSummaryPart(fresh(), {
      part: result("first half"),
      fromSeq: 0,
      toSeq: 3,
      now: 1000,
    });
    summary = appendSummaryPart(summary, {
      part: result("second half"),
      fromSeq: 4,
      toSeq: 7,
      missingSeqs: [5],
      now: 2000,
    });
    summary = withFinalSummary(summary, { result: result("the whole meeting"), now: 3000 });
    expect(summary.coveredThroughSeq).toBe(7);
    expect(summary.missingSeqs).toEqual([5]);

    // Chunk 5 has just been transcribed by an explicit retry.
    const rewound = rewindSummaryCoverage(summary, { throughSeq: 4, now: 4000 });
    expect(rewound.coveredThroughSeq).toBe(4);
    // The part that read 4–7 is gone; the part that read 0–3 is untouched.
    expect(rewound.parts.map((p) => [p.fromSeq, p.toSeq])).toEqual([[0, 3]]);
    expect(rewound.result.summaryText).toBe("first half");
    // The hole is no longer claimed, and the summary is no longer final.
    expect(rewound.missingSeqs).toEqual([]);
    expect(rewound.final).toBe(false);
    expect(rewound.status).toBe(LISTEN_IN_SUMMARY_STATUS.READY);
    // …so the engine asks for the window again, from the corrected transcript.
    expect(
      hasUnsummarisedTranscript({
        chunks: [said(5, lots()), said(6, lots()), said(7, lots())],
        summary: rewound,
        maxAttempts: 5,
      })
    ).toBe(true);
  });

  test("a person's own wording is never touched by a rewind", () => {
    let summary = appendSummaryPart(fresh(), {
      part: result("generated"),
      fromSeq: 0,
      toSeq: 2,
      missingSeqs: [1],
      now: 1000,
    });
    summary = withUserSummaryText(summary, "What I actually think happened", { now: 1500 });
    const rewound = rewindSummaryCoverage(summary, { throughSeq: 0, now: 2000 });
    expect(rewound.userSummaryText).toBe("What I actually think happened");
    expect(summaryDisplayText(rewound)).toBe("What I actually think happened");
  });

  test("rewinding to where it already is, or past it, changes nothing at all", () => {
    const summary = appendSummaryPart(fresh(), {
      part: result("all of it"),
      fromSeq: 0,
      toSeq: 3,
      now: 1000,
    });
    expect(rewindSummaryCoverage(summary, { throughSeq: 3, now: 2000 })).toBe(summary);
    expect(rewindSummaryCoverage(summary, { throughSeq: 9, now: 2000 })).toBe(summary);
    expect(rewindSummaryCoverage(null, { throughSeq: 0 })).toBeNull();
  });

  test("rewinding past the beginning empties the summary rather than inventing one", () => {
    const summary = appendSummaryPart(fresh(), {
      part: result("only part"),
      fromSeq: 0,
      toSeq: 1,
      missingSeqs: [0],
      now: 1000,
    });
    const rewound = rewindSummaryCoverage(summary, { throughSeq: -1, now: 2000 });
    expect(rewound.coveredThroughSeq).toBe(-1);
    expect(rewound.parts).toEqual([]);
    expect(rewound.missingSeqs).toEqual([]);
    expect(rewound.result.summaryText).toBe("");
    expect(hasSummaryToShow(rewound)).toBe(false);
  });
});
