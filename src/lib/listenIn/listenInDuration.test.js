// src/lib/listenIn/listenInDuration.test.js
//
// THE DURATION POLICY AS ARITHMETIC (Phase 8D.3).
//
// The engine's behaviour around the two boundaries is proved in
// listenInLifecycle.test.js, over a real engine. What is proved HERE is the
// thing that behaviour rests on: that a session's four-hour budget is ACTUAL
// CAPTURE TIME, that interrupted time is not part of it, and that the answer
// is derived from the session's own clock rather than from anything that had
// to be running to be right.
//
// Pure: no engine, no timers, no store, no React.
import {
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
  beginLeg,
  captureEnded,
  createSession,
  elapsedMs,
  interrupt,
  listenInStatusLabel,
  markLimitWarned,
  normaliseSession,
  resumeRecording,
  stoppedAtDurationLimit,
} from "./listenInModel";
import {
  LISTEN_IN_DURATION_POLICY,
  LISTEN_IN_MAX_CAPTURE_MS,
  LISTEN_IN_WARN_AFTER_MS,
  canResumeWithinBudget,
  listenInDurationStatus,
  listenInNextDurationCheckMs,
} from "./listenInPolicy";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const T0 = 1_700_000_000_000;

function startedSession(at = T0) {
  return beginLeg(
    createSession({
      sessionId: "sess-1",
      uid: "uid-a",
      workspaceId: "ws-1",
      startedAt: at,
      language: "en",
    }),
    { now: at }
  );
}

/* ========================== the two boundaries =========================== */

describe("the policy is 2 hours and 4 hours, and nothing else", () => {
  test("the warning is at two hours and the hard maximum at four", () => {
    expect(LISTEN_IN_WARN_AFTER_MS).toBe(2 * HOUR);
    expect(LISTEN_IN_MAX_CAPTURE_MS).toBe(4 * HOUR);
    expect(LISTEN_IN_DURATION_POLICY.warnAfterMs).toBe(2 * HOUR);
    expect(LISTEN_IN_DURATION_POLICY.maxMs).toBe(4 * HOUR);
  });

  test("there is no eight-hour mode anywhere in the policy", () => {
    expect(Object.values(LISTEN_IN_DURATION_POLICY)).not.toContain(8 * HOUR);
    expect(LISTEN_IN_MAX_CAPTURE_MS).toBeLessThan(8 * HOUR);
  });

  test("1. nothing is warned about before two hours", () => {
    const session = startedSession();
    const at = (ms) => listenInDurationStatus(session, { now: T0 + ms });
    expect(at(0).shouldWarn).toBe(false);
    expect(at(HOUR).shouldWarn).toBe(false);
    expect(at(2 * HOUR - 1).shouldWarn).toBe(false);
    expect(at(2 * HOUR - 1).exhausted).toBe(false);
  });

  test("2. the warning applies AT two hours and stays true after it", () => {
    const session = startedSession();
    expect(listenInDurationStatus(session, { now: T0 + 2 * HOUR }).shouldWarn).toBe(true);
    expect(listenInDurationStatus(session, { now: T0 + 3 * HOUR }).shouldWarn).toBe(true);
    // And it is a WARNING ONLY: the budget is not spent.
    expect(listenInDurationStatus(session, { now: T0 + 3 * HOUR }).exhausted).toBe(false);
    expect(listenInDurationStatus(session, { now: T0 + 3 * HOUR }).remainingMs).toBe(HOUR);
  });

  test("5. the budget is exhausted AT four hours, and past it", () => {
    const session = startedSession();
    expect(listenInDurationStatus(session, { now: T0 + 4 * HOUR - 1 }).exhausted).toBe(false);
    expect(listenInDurationStatus(session, { now: T0 + 4 * HOUR }).exhausted).toBe(true);
    expect(listenInDurationStatus(session, { now: T0 + 9 * HOUR }).exhausted).toBe(true);
    expect(listenInDurationStatus(session, { now: T0 + 9 * HOUR }).remainingMs).toBe(0);
  });

  test("3. `warned` is a fact about the SESSION, recorded once and never repeated", () => {
    const session = startedSession();
    expect(listenInDurationStatus(session, { now: T0 + 2 * HOUR }).warned).toBe(false);
    const warned = markLimitWarned(session, { now: T0 + 2 * HOUR });
    expect(warned.limitWarnedAt).toBe(T0 + 2 * HOUR);
    expect(listenInDurationStatus(warned, { now: T0 + 2 * HOUR }).warned).toBe(true);
    // Marking again changes nothing — the same object comes back.
    expect(markLimitWarned(warned, { now: T0 + 3 * HOUR })).toBe(warned);
    // And it survives an interruption and a resume, so a long session is not
    // re-warned every time it comes back.
    const stopped = interrupt(warned, { now: T0 + 2 * HOUR + MINUTE });
    const resumed = resumeRecording(stopped, { now: T0 + 3 * HOUR });
    expect(resumed.limitWarnedAt).toBe(T0 + 2 * HOUR);
    expect(listenInDurationStatus(resumed, { now: T0 + 3 * HOUR }).warned).toBe(true);
  });
});

/* ========================= accumulated capture time ====================== */

describe("8. the budget is CAPTURE time — interrupted time is not part of it", () => {
  test("record 90 min, interrupted 30 min, resume 150 min = exactly four hours", () => {
    // The worked example from the phase brief, step by step.
    let session = startedSession();
    // 90 minutes of recording.
    session = interrupt(session, { now: T0 + 90 * MINUTE });
    expect(elapsedMs(session, T0 + 90 * MINUTE)).toBe(90 * MINUTE);
    // 30 minutes interrupted: the clock runs, the budget does not.
    const backAt = T0 + 120 * MINUTE;
    expect(elapsedMs(session, backAt)).toBe(90 * MINUTE);
    expect(listenInDurationStatus(session, { now: backAt }).shouldWarn).toBe(false);
    expect(canResumeWithinBudget(session, { now: backAt })).toBe(true);
    // Resumed for 150 minutes: 90 + 150 = 240 = four hours.
    session = resumeRecording(session, { now: backAt });
    const end = backAt + 150 * MINUTE;
    expect(elapsedMs(session, end)).toBe(4 * HOUR);
    expect(listenInDurationStatus(session, { now: end }).exhausted).toBe(true);
    // Wall clock says four and a half hours; the budget says four.
    expect(end - session.startedAt).toBe(270 * MINUTE);
  });

  test("wall-clock metadata is preserved separately and is NOT the budget", () => {
    let session = startedSession();
    session = captureEnded(session, { now: T0 + 30 * MINUTE });
    expect(session.startedAt).toBe(T0);
    expect(session.stoppedAt).toBe(T0 + 30 * MINUTE);
    expect(session.capturedMs).toBe(30 * MINUTE);
    expect(session.legStartedAt).toBeNull();
  });

  test("many short legs accumulate, and a session not recording banks nothing", () => {
    let session = startedSession();
    for (let i = 0; i < 5; i += 1) {
      session = interrupt(session, { now: elapsedStart(session, i) + 20 * MINUTE });
      session = resumeRecording(session, { now: elapsedStart(session, i) + 60 * MINUTE });
    }
    // Five twenty-minute legs plus the open sixth leg at zero.
    expect(session.capturedMs).toBe(100 * MINUTE);
    const at = session.legStartedAt;
    expect(elapsedMs(session, at)).toBe(100 * MINUTE);
    expect(elapsedMs(session, at + 10 * MINUTE)).toBe(110 * MINUTE);

    function elapsedStart(s, i) {
      return T0 + i * 60 * MINUTE;
    }
  });

  test("a crash-recovered leg banks only up to the last known capture, not to the reload", () => {
    // The tab died at T0 + 40 min; the app is reopened eleven hours later.
    const session = startedSession();
    const diedAt = T0 + 40 * MINUTE;
    const reopenedAt = T0 + 11 * HOUR;
    const recovered = interrupt(session, { now: reopenedAt, capturedThrough: diedAt });
    expect(recovered.capturedMs).toBe(40 * MINUTE);
    // Which is the whole point: the session may still be resumed.
    expect(listenInDurationStatus(recovered, { now: reopenedAt }).exhausted).toBe(false);
    expect(canResumeWithinBudget(recovered, { now: reopenedAt })).toBe(true);
  });

  test("the evidence can only SHORTEN a leg — a future timestamp cannot invent capture", () => {
    const session = startedSession();
    const now = T0 + 10 * MINUTE;
    const lying = interrupt(session, { now, capturedThrough: T0 + 99 * HOUR });
    expect(lying.capturedMs).toBe(10 * MINUTE);
    const nonsense = interrupt(session, { now, capturedThrough: T0 - 5 * HOUR });
    expect(nonsense.capturedMs).toBe(0);
  });
});

/* ============================ refusing a resume ========================== */

describe("12. a session that has spent its budget may be finished, not resumed", () => {
  test("canResumeWithinBudget is false at and past four hours", () => {
    let session = startedSession();
    session = interrupt(session, { now: T0 + 4 * HOUR });
    expect(session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(canResumeWithinBudget(session, { now: T0 + 4 * HOUR })).toBe(false);
    expect(canResumeWithinBudget(session, { now: T0 + 5 * HOUR })).toBe(false);
  });

  test("and it is true for a session with budget left, however long ago it ran", () => {
    let session = startedSession();
    session = interrupt(session, { now: T0 + 3 * HOUR + 59 * MINUTE });
    expect(canResumeWithinBudget(session, { now: T0 + 40 * HOUR })).toBe(true);
  });

  test("no session at all is not resumable", () => {
    expect(canResumeWithinBudget(null)).toBe(false);
  });
});

/* ============================ the next wake-up =========================== */

describe("the wake-up is only a wake-up — the decision is always recomputed", () => {
  test("it points at the warning boundary first, then at the limit", () => {
    const session = startedSession();
    expect(listenInNextDurationCheckMs(session, { now: T0 })).toBe(2 * HOUR);
    expect(listenInNextDurationCheckMs(session, { now: T0 + 90 * MINUTE })).toBe(30 * MINUTE);
    expect(listenInNextDurationCheckMs(session, { now: T0 + 2 * HOUR })).toBe(2 * HOUR);
    expect(listenInNextDurationCheckMs(session, { now: T0 + 3 * HOUR })).toBe(HOUR);
  });

  test("7. a session already past the limit wants looking at immediately", () => {
    const session = startedSession();
    expect(listenInNextDurationCheckMs(session, { now: T0 + 4 * HOUR + 15 * MINUTE })).toBe(0);
  });

  test("the status is derived, so a session that was never observed still reads true", () => {
    // Nothing ticked, nothing counted, nothing was mounted: the answer comes
    // from `startedAt`/`capturedMs` alone.
    const session = startedSession();
    const status = listenInDurationStatus(session, { now: T0 + 6 * HOUR });
    expect(status.capturedMs).toBe(6 * HOUR);
    expect(status.exhausted).toBe(true);
    expect(status.shouldWarn).toBe(true);
    expect(status.remainingMs).toBe(0);
    expect(status.untilWarningMs).toBe(0);
  });
});

/* ======================== backwards-safe migration ====================== */

describe("a session written before the duration fields existed is read the same way", () => {
  test("normaliseSession fills the defaults without changing anything present", () => {
    // Exactly the shape an 8D.1/8D.2 development build could have stored.
    const legacy = {
      uid: "uid-a",
      workspaceId: "ws-1",
      sessionId: "old",
      startedAt: T0,
      stoppedAt: null,
      state: LISTEN_IN_STATE.INTERRUPTED,
      stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
      language: "en",
      nextSeq: 4,
      updatedAt: T0,
    };
    const normalised = normaliseSession(legacy);
    expect(normalised.capturedMs).toBe(0);
    expect(normalised.legStartedAt).toBeNull();
    expect(normalised.limitWarnedAt).toBeNull();
    // Nothing else was touched.
    expect(normalised.nextSeq).toBe(4);
    expect(normalised.sessionId).toBe("old");
    expect(normalised.stopReason).toBe(LISTEN_IN_STOP_REASON.INTERRUPTION);
    // And it reads as a resumable session rather than an exhausted one.
    expect(canResumeWithinBudget(normalised, { now: T0 + 20 * HOUR })).toBe(true);
  });

  test("a session that needs nothing is returned unchanged, by reference", () => {
    const session = startedSession();
    expect(normaliseSession(session)).toBe(session);
    expect(normaliseSession(null)).toBeNull();
  });

  test("elapsedMs tolerates a header with no duration fields at all", () => {
    expect(elapsedMs({ startedAt: T0 }, T0 + HOUR)).toBe(0);
  });
});

/* =============================== the wording ============================= */

describe("29/32. what the user is told, and what they are not asked to do", () => {
  test("a session stopped by the policy is recognisable as such", () => {
    let session = startedSession();
    session = captureEnded(
      { ...session, stopReason: LISTEN_IN_STOP_REASON.LIMIT },
      { now: T0 + 4 * HOUR }
    );
    expect(session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    expect(stoppedAtDurationLimit(session)).toBe(true);
    expect(stoppedAtDurationLimit(startedSession())).toBe(false);
    expect(stoppedAtDurationLimit(null)).toBe(false);
  });

  test("the status sentence distinguishes finishing transcript from finalising summary", () => {
    const finishing = captureEnded(startedSession(), { now: T0 + HOUR });
    const pending = [{ seq: 0, state: "sealed" }];
    expect(listenInStatusLabel(finishing, pending)).toBe(
      "Completing meeting — 1 part still transcribing…"
    );
    expect(listenInStatusLabel(finishing, [])).toBe("Completing meeting…");
    // Nothing left to transcribe, but the summary has not been consolidated.
    expect(
      listenInStatusLabel(finishing, [], { summary: { final: false, parts: [{ fromSeq: 0 }] } })
    ).toBe("Completing meeting — finalising summary…");
    expect(
      listenInStatusLabel(finishing, [], { summary: { final: true, parts: [{ fromSeq: 0 }] } })
    ).toBe("Completing meeting…");
    // A session with nothing summarised at all is not "finalising" anything.
    expect(listenInStatusLabel(finishing, [], { summary: { final: false, parts: [] } })).toBe(
      "Completing meeting…"
    );
  });
});
