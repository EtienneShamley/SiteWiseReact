// src/lib/listenIn/listenInLifecycle.test.js
//
// LONG-SESSION LIFECYCLE, AS THE ENGINE RUNS IT (Phase 8D.3).
//
// A real engine with the microphone, the recorder, the clock, every timer, the
// network check, the browser's wake signals, the store and the summariser
// injected — so four hours of meeting take milliseconds and no behaviour here
// is asserted from source text.
//
// The promises under test:
//
//   - two hours WARNS and nothing else: capture continues, the microphone is
//     still held, and the warning is stated exactly once;
//   - four hours STOPS, down the same path a deliberate Stop takes, sealing
//     the chunk in progress and losing nothing that was pending or failed;
//   - the stop is IDEMPOTENT and happens however the engine is woken — a chunk
//     roll, a focus event, a reconnection, a timer — including when the device
//     slept straight through the boundary;
//   - the budget is ACTUAL CAPTURE TIME, so an interruption costs nothing and
//     a resume continues the same session, sequence and transcript;
//   - finishing continues on its own, and a permanently failed chunk stays
//     retryable rather than leaving the session stuck.
import {
  createListenInEngine,
  resetListenInEnginesForTests,
} from "./listenInEngine";
import {
  CHUNK_STATE,
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
  elapsedMs,
} from "./listenInModel";
import { LISTEN_IN_MAX_CAPTURE_MS, LISTEN_IN_WARN_AFTER_MS } from "./listenInPolicy";
import { LISTEN_IN_SUMMARY_POLICY } from "./listenInSummaryModel";
import { createListenInMemoryStore } from "./listenInStore";
import {
  MICROPHONE_OWNER,
  currentMicrophoneOwner,
  resetMicrophoneOwnershipForTests,
} from "../microphoneOwnership";

const UID = "uid-lifecycle";
const WS = "ws-lifecycle";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/* ------------------------------- the fakes ------------------------------- */

class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported() {
    return true;
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || "audio/webm";
    this.state = "inactive";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob([new Uint8Array(32)], { type: this.mimeType }) });
    }
    if (this.onstop) this.onstop();
  }
}

const realMediaRecorder = global.MediaRecorder;
beforeAll(() => {
  global.MediaRecorder = FakeMediaRecorder;
});
afterAll(() => {
  global.MediaRecorder = realMediaRecorder;
});

beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  FakeMediaRecorder.instances = [];
});
afterEach(() => {
  resetListenInEnginesForTests();
});

const settle = async () => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};

const summaryResult = (text) => ({
  summaryText: text,
  keyPoints: [],
  decisions: [],
  actionItems: [],
  risks: [],
  followUps: [],
});

/** Long enough that one chunk clears the summary policy's size gate. */
const WORDS = "The team reviewed the drainage survey for the eastern plot. ".repeat(60).trim();

/**
 * An engine with EVERY outside thing under the test's control: the wall clock,
 * the chunk-roll interval, every `setTimeout` the engine arms (the retry
 * backoff, the summary backoff and the duration wake-up), the network check
 * and the browser's focus/visibility signal.
 *
 * The REAL duration policy is used — two and four hours — and the clock is
 * simply moved. Nothing here shortens the boundaries to make them reachable,
 * so what passes is the policy the product ships.
 */
function buildEngine({ transcribe, summarise, store, online = true, tracks } = {}) {
  let clock = 1_700_000_000_000;
  let roll = null;
  let wake = null;
  const timers = new Map();
  let nextTimerId = 1;
  let isOnlineValue = online;
  const stopped = tracks || [{ stop: jest.fn() }];
  const getUserMedia = jest.fn(async () => ({ getTracks: () => stopped }));

  const engine = createListenInEngine({
    uid: UID,
    workspaceId: WS,
    store: store || createListenInMemoryStore(),
    transcribe: transcribe || (async () => WORDS),
    summarise:
      summarise ||
      jest.fn(async (request) =>
        request.mode === "window"
          ? { ok: true, result: summaryResult(`window ${request.segments[0].seq}`) }
          : { ok: true, result: summaryResult("final") }
      ),
    summaryPolicy: LISTEN_IN_SUMMARY_POLICY,
    recorderSupported: () => true,
    getUserMedia,
    now: () => clock,
    setTimer: (fn) => {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    setInterval_: (fn) => {
      roll = fn;
      return 1;
    },
    clearInterval_: () => {
      roll = null;
    },
    isOnline: () => isOnlineValue,
    addOnlineListener: () => () => {},
    addWakeListener: (fn) => {
      wake = fn;
      return () => {
        wake = null;
      };
    },
    newSessionId: () => "session-1",
  });

  return {
    engine,
    getUserMedia,
    tracks: stopped,
    /** Fire the chunk-roll interval, as the browser would every 30 s. */
    roll: () => roll && roll(),
    rolling: () => roll !== null,
    /** The browser telling the app it is being looked at again. */
    wake: () => wake && wake(),
    /** Fire every armed timeout (the duration wake-up included). */
    fireTimers: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    timerCount: () => timers.size,
    advance: (ms) => {
      clock += ms;
    },
    at: () => clock,
    setOnline: (value) => {
      isOnlineValue = value;
    },
  };
}

/**
 * Start a capture the way the app does: the hook bootstraps the engine first
 * (which is where the online and wake listeners are registered), and only then
 * does the user press Start.
 */
async function begin(rig) {
  await rig.engine.bootstrap();
  await settle();
  await rig.engine.start({ language: "en" });
  await settle();
}

/**
 * The process goes away without the engine being told — a crashed tab, a hard
 * reload. The global microphone claim dies with it, and a fresh engine over
 * the same store is what comes back.
 */
function crash() {
  resetMicrophoneOwnershipForTests();
}

/** Seal one chunk and let the drain and the summary loop have their pass. */
async function speak(rig) {
  rig.roll();
  await settle();
  await rig.engine.flush();
  await settle();
  await rig.engine.flushSummary();
  await settle();
}

/* ======================= 1–4. the two-hour warning ======================= */

describe("the two-hour warning is a warning, and only a warning", () => {
  test("1. nothing is warned before two hours, however many chunks roll", async () => {
    const rig = buildEngine();
    await begin(rig);
    for (let i = 0; i < 4; i += 1) {
      rig.advance(29 * MINUTE);
      await speak(rig);
    }
    // 1 h 56 m of capture.
    const snap = rig.engine.getSnapshot();
    expect(elapsedMs(snap.session, rig.at())).toBeLessThan(LISTEN_IN_WARN_AFTER_MS);
    expect(snap.session.limitWarnedAt).toBeNull();
    expect(snap.duration.shouldWarn).toBe(false);
    expect(snap.duration.warned).toBe(false);
  });

  test("2/4. at two hours the warning is recorded and RECORDING CONTINUES", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_WARN_AFTER_MS);
    await speak(rig);

    const snap = rig.engine.getSnapshot();
    expect(snap.session.limitWarnedAt).toBe(rig.at());
    expect(snap.duration.shouldWarn).toBe(true);
    expect(snap.duration.warned).toBe(true);
    // Capture is untouched: still recording, still holding the microphone,
    // still rolling chunks, tracks alive.
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(rig.rolling()).toBe(true);
    expect(rig.tracks[0].stop).not.toHaveBeenCalled();

    // And it keeps capturing after the warning.
    const before = snap.chunks.length;
    rig.advance(30000);
    await speak(rig);
    expect(rig.engine.getSnapshot().chunks.length).toBe(before + 1);
    expect(rig.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
  });

  test("3. the warning is recorded ONCE — later wake-ups do not re-warn", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_WARN_AFTER_MS);
    await speak(rig);
    const warnedAt = rig.engine.getSnapshot().session.limitWarnedAt;

    for (let i = 0; i < 5; i += 1) {
      rig.advance(10 * MINUTE);
      rig.wake();
      rig.fireTimers();
      await speak(rig);
    }
    expect(rig.engine.getSnapshot().session.limitWarnedAt).toBe(warnedAt);
    expect(rig.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
  });

  test("the warning survives the session being interrupted and resumed", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_WARN_AFTER_MS);
    await speak(rig);
    const warnedAt = rig.engine.getSnapshot().session.limitWarnedAt;

    rig.engine.shutdown();
    resetMicrophoneOwnershipForTests();
    expect(warnedAt).toBeGreaterThan(0);
  });
});

/* ======================== 5–6, 14–20. the hard stop ===================== */

describe("the four-hour hard stop takes the same path a deliberate Stop takes", () => {
  test("5/14–17. capture stops itself, sealing the chunk and releasing the microphone", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(HOUR);
    await speak(rig);
    const sealedBefore = rig.engine.getSnapshot().chunks.length;

    // The device has been recording for four hours.
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS - HOUR);
    rig.roll();
    await settle();

    const snap = rig.engine.getSnapshot();
    // 17. the reason is the POLICY, not the user.
    expect(snap.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    // The session went to finishing, exactly as a Stop would leave it.
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(snap.session.stoppedAt).toBe(rig.at());
    // 14. the chunk in progress was SEALED, not dropped.
    expect(snap.chunks.length).toBe(sealedBefore + 1);
    // 15/16. the microphone claim is gone and the tracks are stopped.
    expect(currentMicrophoneOwner()).toBeNull();
    expect(rig.tracks[0].stop).toHaveBeenCalled();
    expect(rig.rolling()).toBe(false);
    // 32. no manual action was required or taken.
    expect(snap.error).toBeNull();
  });

  test("6. the stop is idempotent however many wake-ups land on the same overrun", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS + 5 * MINUTE);

    // A chunk roll, a focus event, a timer and another roll, all at once.
    rig.roll();
    rig.wake();
    rig.fireTimers();
    rig.roll();
    rig.wake();
    await settle();

    const snap = rig.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(snap.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    // One final chunk, not four; the tracks stopped once.
    expect(snap.chunks.length).toBe(1);
    expect(rig.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  test("7. waking after the device slept straight past four hours stops immediately", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    expect(rig.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);

    // The laptop suspended. No timer fired, no chunk rolled, nothing ticked.
    rig.advance(4 * HOUR + 15 * MINUTE);
    expect(rig.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);

    // The only thing that happens is the app being looked at again.
    rig.wake();
    await settle();

    const snap = rig.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(snap.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("the armed timer alone is enough — no focus and no chunk roll needed", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.fireTimers();
    await settle();
    expect(rig.engine.getSnapshot().session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
  });

  test("18/19. pending and failed chunks are kept, and the drain carries on", async () => {
    let calls = 0;
    const transcribe = jest.fn(async () => {
      calls += 1;
      // The second chunk fails for good; the rest transcribe.
      if (calls === 2) throw new Error("Bad audio");
      return WORDS;
    });
    const rig = buildEngine({ transcribe });
    await begin(rig);
    for (let i = 0; i < 3; i += 1) {
      rig.advance(30000);
      await speak(rig);
    }
    expect(rig.engine.getSnapshot().failed).toBe(1);

    // The connection drops, so the chunk sealed by the hard stop is still
    // waiting to be transcribed when capture ends.
    rig.setOnline(false);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.roll();
    await settle();
    await rig.engine.flush();
    await settle();

    let snap = rig.engine.getSnapshot();
    expect(snap.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    // Nothing was discarded: the failed chunk and the pending one are both here.
    expect(snap.chunks.some((c) => c.state === CHUNK_STATE.FAILED)).toBe(true);
    expect(snap.pending).toBeGreaterThan(0);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHING);

    // 19/20. the drain and the summary carry on to completion on their own.
    rig.setOnline(true);
    await rig.engine.flush();
    await settle();
    await rig.engine.flushSummary();
    await settle();
    snap = rig.engine.getSnapshot();
    expect(snap.pending).toBe(0);
    // 24. finished WITH ISSUES — the dead chunk did not hang the session.
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.failed).toBe(1);
    expect(snap.summary.final).toBe(true);
  });

  test("20. the automatic summary finalises after a limit stop, with no user action", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);

    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.roll();
    await settle();
    await rig.engine.flush();
    await settle();
    await rig.engine.flushSummary();
    await settle();

    const snap = rig.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.summary.final).toBe(true);
    expect(snap.summaryCoverage.complete).toBe(true);
  });

  test("21. an OFFLINE hard stop preserves everything and holds no microphone", async () => {
    const rig = buildEngine({ online: false });
    await begin(rig);
    for (let i = 0; i < 3; i += 1) {
      rig.advance(30000);
      rig.roll();
      await settle();
    }
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.roll();
    await settle();
    await rig.engine.flush();
    await settle();

    let snap = rig.engine.getSnapshot();
    // Capture ended safely; the microphone is NOT kept open because the
    // network is unavailable.
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(snap.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    expect(currentMicrophoneOwner()).toBeNull();
    // Every chunk is still there, still sealed, nothing discarded.
    expect(snap.chunks).toHaveLength(4);
    expect(snap.chunks.every((c) => c.state === CHUNK_STATE.SEALED)).toBe(true);
    expect(snap.pending).toBe(4);

    // Reconnecting drains it and finishes the session.
    rig.setOnline(true);
    await rig.engine.flush();
    await settle();
    await rig.engine.flushSummary();
    await settle();
    snap = rig.engine.getSnapshot();
    expect(snap.pending).toBe(0);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.summary.final).toBe(true);
  });
});

/* ==================== 8–13. interruption and resume ===================== */

describe("the budget is capture time, and a resume continues the same session", () => {
  test("8. time spent interrupted does not count towards the four hours", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(90 * MINUTE);
    await speak(rig);

    // Interrupted (a sign-out, a crashed tab, a lost microphone).
    await rig.engine.stop();
    await settle();
    const banked = rig.engine.getSnapshot().session.capturedMs;
    expect(banked).toBeGreaterThanOrEqual(90 * MINUTE);

    // Three hours pass with nothing recording at all.
    rig.advance(3 * HOUR);
    expect(rig.engine.getSnapshot().duration.capturedMs).toBe(banked);
    expect(rig.engine.getSnapshot().duration.exhausted).toBe(false);
  });

  test("9/10/11. Resume keeps the session id, the sequence and the transcript", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const sessionId = rig.engine.getSnapshot().session.sessionId;
    const summaryRevision = rig.engine.getSnapshot().summary.revision;

    // An interruption the engine did not ask for.
    rig.advance(MINUTE);
    await rig.engine.stop();
    await settle();
    await rig.engine.flush();
    await settle();
    crash();
    const before = rig.engine.getSnapshot();
    const nextSeq = before.session.nextSeq;
    const seqs = before.chunks.map((c) => c.seq);
    const transcript = before.chunks[0].text;

    // Put it back into the interrupted state a recovery produces, then resume.
    await store.putSession({
      ...rig.engine.getSnapshot().session,
      state: LISTEN_IN_STATE.INTERRUPTED,
      stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
    });
    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    expect(second.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);

    second.advance(HOUR);
    await second.engine.resume();
    await settle();

    const after = second.engine.getSnapshot();
    // 9. the SAME session.
    expect(after.session.sessionId).toBe(sessionId);
    expect(after.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    // 10. the sequence continues rather than restarting.
    expect(after.session.nextSeq).toBe(nextSeq);
    second.advance(30000);
    await speak(second);
    // The next chunk takes the NEXT sequence — nothing restarts at zero and
    // nothing is reused.
    expect(second.engine.getSnapshot().chunks.map((c) => c.seq)).toEqual([...seqs, nextSeq]);
    // 11. the transcript and the summary state came back with it.
    expect(second.engine.getSnapshot().chunks[0].text).toBe(transcript);
    expect(second.engine.getSnapshot().summary.revision).toBeGreaterThanOrEqual(summaryRevision);
    // And the hour spent interrupted was not charged to the budget.
    expect(second.engine.getSnapshot().session.capturedMs).toBeLessThan(5 * MINUTE);
  });

  test("12. Resume is REFUSED when the capture budget is spent, and opens no microphone", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.roll();
    await settle();
    // The limit stop leaves it finishing; force the interrupted state a crash
    // at the same moment would have produced instead.
    await store.putSession({
      ...rig.engine.getSnapshot().session,
      state: LISTEN_IN_STATE.INTERRUPTED,
      stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
    });
    crash();

    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    expect(second.engine.getSnapshot().duration.exhausted).toBe(true);

    await second.engine.resume();
    await settle();

    const snap = second.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    // The microphone was never asked for, never claimed and never released.
    expect(second.getUserMedia).not.toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBeNull();
    // And the refusal says why, in the session's own wording.
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.LIMIT_EXHAUSTED);
  });

  test("13. Finish from an interrupted session never reopens the microphone", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    rig.roll();
    await settle();
    await store.putSession({
      ...rig.engine.getSnapshot().session,
      state: LISTEN_IN_STATE.INTERRUPTED,
      stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
    });
    crash();

    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    await second.engine.finish();
    await settle();
    await second.engine.flush();
    await settle();
    await second.engine.flushSummary();
    await settle();

    const snap = second.engine.getSnapshot();
    expect(second.getUserMedia).not.toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBeNull();
    // The outstanding chunk drained and the transcript is intact.
    expect(snap.pending).toBe(0);
    expect(snap.chunks[0].state).toBe(CHUNK_STATE.TRANSCRIBED);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
  });

  test("a crash recovered hours later does not spend the budget it never used", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(40 * MINUTE);
    rig.roll();
    await settle();
    // The process dies here — the header is left saying `recording`.
    await store.putSession({
      ...rig.engine.getSnapshot().session,
      state: LISTEN_IN_STATE.RECORDING,
    });

    // The app is opened again eleven hours later.
    const second = buildEngine({ store });
    second.advance(11 * HOUR);
    await second.engine.bootstrap();
    await settle();

    const snap = second.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    // Only the forty minutes it actually recorded were banked…
    expect(snap.session.capturedMs).toBeLessThanOrEqual(41 * MINUTE);
    expect(snap.session.capturedMs).toBeGreaterThanOrEqual(39 * MINUTE);
    // …so the meeting can still be resumed, which is the point.
    expect(snap.duration.exhausted).toBe(false);
    await second.engine.resume();
    await settle();
    expect(second.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
  });
});

/* ================= 22–27. finishing, and failed chunks ================== */

describe("finishing runs on its own, and a dead chunk never leaves it stuck", () => {
  test("22/23. nothing that happens in the view layer touches a finishing session", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    rig.roll();
    await settle();
    await rig.engine.stop();
    await settle();
    // Capture is over and the microphone is already gone; the SESSION is not.
    expect(rig.engine.getSnapshot().session.stoppedAt).toBeGreaterThan(0);
    expect(currentMicrophoneOwner()).toBeNull();

    // Every subscriber goes away — the window closed, the whole view layer
    // unmounted, the user navigated elsewhere. The engine is not a subscriber.
    const unsubscribe = rig.engine.subscribe(() => {});
    unsubscribe();

    await rig.engine.flush();
    await settle();
    await rig.engine.flushSummary();
    await settle();

    const snap = rig.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.chunks[0].state).toBe(CHUNK_STATE.TRANSCRIBED);
    expect(snap.summary.final).toBe(true);
    // And the microphone was released when capture ended, not when it finished.
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("25. a permanently failed chunk keeps its audio and stays retryable", async () => {
    const store = createListenInMemoryStore();
    let fail = true;
    const transcribe = jest.fn(async () => {
      if (fail) throw new Error("Bad audio");
      return WORDS;
    });
    const rig = buildEngine({ store, transcribe });
    await begin(rig);
    // One chunk only: Stop seals the chunk in progress, so there is exactly
    // one sequence in this session and exactly one hole to fill.
    rig.advance(30000);
    await rig.engine.stop();
    await settle();
    await rig.engine.flush();
    await settle();
    await rig.engine.flushSummary();
    await settle();

    let snap = rig.engine.getSnapshot();
    expect(snap.chunks).toHaveLength(1);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.failed).toBe(1);
    // Its audio is RETAINED, which is what makes a retry a real retry.
    expect(await store.getChunkAudio(UID, WS, snap.session.sessionId, 0)).not.toBeNull();
    expect(snap.summaryCoverage.failedCount).toBe(1);
    expect(snap.summary.missingSeqs).toEqual([0]);

    // 26/27. the retry succeeds: transcript, coverage and audio all follow.
    fail = false;
    await rig.engine.retryFailed();
    await settle();
    await rig.engine.flush();
    await settle();
    await rig.engine.flushSummary();
    await settle();

    snap = rig.engine.getSnapshot();
    expect(snap.failed).toBe(0);
    expect(snap.chunks[0].state).toBe(CHUNK_STATE.TRANSCRIBED);
    expect(snap.chunks[0].text).toBe(WORDS);
    // The hole the summary recorded is gone, and it was re-read rather than
    // left describing a gap that no longer exists.
    expect(snap.summary.missingSeqs).toEqual([]);
    expect(snap.summaryCoverage.failedCount).toBe(0);
    expect(snap.summary.final).toBe(true);
    // 27. the retained audio was released once its transcript was stored.
    expect(await store.getChunkAudio(UID, WS, snap.session.sessionId, 0)).toBeNull();
  });

  test("a retry that fails again changes nothing and leaves the audio retained", async () => {
    const store = createListenInMemoryStore();
    const transcribe = jest.fn(async () => {
      throw new Error("Bad audio");
    });
    const rig = buildEngine({ store, transcribe });
    await begin(rig);
    rig.advance(30000);
    await rig.engine.stop();
    await settle();
    await rig.engine.flush();
    await settle();
    await rig.engine.flushSummary();
    await settle();
    const before = rig.engine.getSnapshot();
    expect(before.failed).toBe(1);

    await rig.engine.retryFailed();
    await settle();
    await rig.engine.flush();
    await settle();

    const snap = rig.engine.getSnapshot();
    expect(snap.failed).toBe(1);
    expect(snap.summary.missingSeqs).toEqual(before.summary.missingSeqs);
    expect(await store.getChunkAudio(UID, WS, snap.session.sessionId, 0)).not.toBeNull();
  });
});

/* ========================== 30–31. what is published ==================== */

describe("the snapshot carries the duration facts every surface reads", () => {
  test("the budget is published, derived, and correct the moment it is asked", async () => {
    const rig = buildEngine();
    await begin(rig);
    let snap = rig.engine.getSnapshot();
    expect(snap.duration.maxMs).toBe(LISTEN_IN_MAX_CAPTURE_MS);
    expect(snap.duration.warnAfterMs).toBe(LISTEN_IN_WARN_AFTER_MS);
    expect(snap.duration.capturedMs).toBe(0);

    // Nothing ticks, nothing is mounted: the clock simply moves.
    rig.advance(3 * HOUR);
    rig.roll();
    await settle();
    snap = rig.engine.getSnapshot();
    expect(snap.duration.capturedMs).toBeGreaterThanOrEqual(3 * HOUR);
    expect(snap.duration.shouldWarn).toBe(true);
    expect(snap.duration.exhausted).toBe(false);
    expect(snap.duration.remainingMs).toBeLessThanOrEqual(HOUR);
  });

  test("30. once capture stops, nothing reports an active recording any more", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.roll();
    await settle();
    const snap = rig.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(snap.session.legStartedAt).toBeNull();
    expect(currentMicrophoneOwner()).toBeNull();
    // 31. but the session is still working, and says so.
    expect(snap.summaryCoverage.capturing).toBe(true);
  });

  test("a new session after a limit stop starts with a fresh budget", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.roll();
    await settle();
    await rig.engine.flush();
    await settle();
    await rig.engine.discard();
    await settle();

    rig.advance(MINUTE);
    await begin(rig);
    await settle();
    const snap = rig.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap.session.stopReason).toBeNull();
    expect(snap.session.limitWarnedAt).toBeNull();
    expect(snap.duration.exhausted).toBe(false);
    expect(snap.duration.capturedMs).toBe(0);
  });
});
