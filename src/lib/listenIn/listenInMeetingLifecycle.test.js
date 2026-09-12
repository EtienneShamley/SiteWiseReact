// src/lib/listenIn/listenInMeetingLifecycle.test.js
//
// A MEETING IS NOT A MICROPHONE LEG (Phase 8D.3.1).
//
// The real engine with the microphone, the recorder, the clock, every timer,
// the network check, the store and the summariser injected. What is proved:
//
//   PAUSE     ends the microphone leg and nothing else — same meeting, same
//             id, same chunks, same summary, same sequence, same budget;
//             transcription keeps draining; no completion runs.
//   RESUME    reopens the microphone into the SAME meeting.
//   COMPLETE  ends the meeting from any state without ever reopening a
//             microphone, finalises it, keeps the record, and clears it as
//             the active meeting — so the next Start is a NEW meeting.
//   RECOVERY  a crash recovers the SAME unfinished meeting, and nothing
//             silently starts another over it.
//   ACTIVE    at most one uncompleted meeting per account+workspace, found
//             deterministically; a completed one is never mistaken for it.
//   4 HOURS   pause/resume cannot reset the budget; Resume is refused once it
//             is spent; the hard stop still happens exactly once.
import {
  createListenInEngine,
  resetListenInEnginesForTests,
} from "./listenInEngine";
import {
  CHUNK_STATE,
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
} from "./listenInModel";
import { LISTEN_IN_MAX_CAPTURE_MS } from "./listenInPolicy";
import { LISTEN_IN_SUMMARY_POLICY } from "./listenInSummaryModel";
import { createListenInMemoryStore } from "./listenInStore";
import {
  MICROPHONE_OWNER,
  currentMicrophoneOwner,
  resetMicrophoneOwnershipForTests,
} from "../microphoneOwnership";

const UID = "uid-meeting";
const WS = "ws-meeting";
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
const WORDS = "The team walked the eastern boundary and agreed the drainage plan. ".repeat(60).trim();

/**
 * An engine with every outside thing under the test's control. Session ids
 * are minted from a counter so a NEW meeting is visibly a new id.
 */
function buildEngine({ transcribe, summarise, store, online = true, sessionIds } = {}) {
  let clock = 1_700_000_000_000;
  let roll = null;
  let wake = null;
  const timers = new Map();
  let nextTimerId = 1;
  let isOnlineValue = online;
  const tracks = [{ stop: jest.fn() }];
  const getUserMedia = jest.fn(async () => ({ getTracks: () => tracks }));
  let minted = 0;
  const summariser =
    summarise ||
    jest.fn(async (request) =>
      request.mode === "window"
        ? { ok: true, result: summaryResult(`window ${request.segments[0].seq}`) }
        : { ok: true, result: summaryResult("final") }
    );

  const engine = createListenInEngine({
    uid: UID,
    workspaceId: WS,
    store: store || createListenInMemoryStore(),
    transcribe: transcribe || (async () => WORDS),
    summarise: summariser,
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
    newSessionId: sessionIds || (() => `meeting-${(minted += 1)}`),
  });

  return {
    engine,
    getUserMedia,
    summarise: summariser,
    tracks,
    roll: () => roll && roll(),
    rolling: () => roll !== null,
    wake: () => wake && wake(),
    fireTimers: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    advance: (ms) => {
      clock += ms;
    },
    at: () => clock,
    setOnline: (value) => {
      isOnlineValue = value;
    },
  };
}

async function begin(rig) {
  await rig.engine.bootstrap();
  await settle();
  await rig.engine.start({ language: "en" });
  await settle();
}

/** The process dies: the microphone claim goes with it, the store does not. */
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

/** Let the drain and the summary loop run to rest. */
async function drain(rig) {
  await rig.engine.flush();
  await settle();
  await rig.engine.flushSummary();
  await settle();
}

const snap = (rig) => rig.engine.getSnapshot();

/* ================================ 6–15. PAUSE ============================= */

describe("Pause ends the microphone leg and keeps the meeting", () => {
  test("6/7/8. Pause seals the chunk in progress, stops the recorder and tracks, and releases the microphone", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const sealedBefore = snap(rig).chunks.length;
    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    expect(recorder.state).toBe("recording");

    rig.advance(10000);
    await rig.engine.pause();
    await settle();

    const s = snap(rig);
    expect(s.session.state).toBe(LISTEN_IN_STATE.PAUSED);
    // 6. the ten seconds in progress were sealed as a chunk, not dropped.
    expect(s.chunks.length).toBe(sealedBefore + 1);
    // 7. the recorder is stopped, the roll disarmed, the tracks stopped.
    expect(recorder.state).toBe("inactive");
    expect(rig.rolling()).toBe(false);
    expect(rig.tracks[0].stop).toHaveBeenCalled();
    // 8. nobody holds the microphone.
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("9/10/11/12. Pause keeps the SAME meeting: id, transcript, summary, next sequence", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const before = snap(rig);
    expect(before.summary.parts.length).toBeGreaterThan(0);

    await rig.engine.pause();
    await settle();
    await drain(rig);

    const after = snap(rig);
    expect(after.session.sessionId).toBe(before.session.sessionId);
    expect(after.active).toBe(true);
    expect(after.chunks[0].text).toBe(before.chunks[0].text);
    // The summary record is the same one, not reset and not consolidated.
    expect(after.summary.sessionId).toBe(before.summary.sessionId);
    expect(after.summary.parts.length).toBeGreaterThanOrEqual(before.summary.parts.length);
    expect(after.summary.final).toBe(false);
    // The next sequence continues from where the leg ended.
    expect(after.session.nextSeq).toBe(after.chunks.length);
    expect(after.session.nextSeq).toBeGreaterThan(before.session.nextSeq - 1);
  });

  test("13. paused wall-clock time does not consume the capture budget", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(20 * MINUTE);
    await rig.engine.pause();
    await settle();
    const banked = snap(rig).session.capturedMs;
    expect(banked).toBe(20 * MINUTE);

    // Paused for five hours. The clock runs; the budget does not.
    rig.advance(5 * HOUR);
    rig.wake();
    rig.fireTimers();
    await settle();
    expect(snap(rig).session.capturedMs).toBe(banked);
    expect(snap(rig).duration.capturedMs).toBe(banked);
    expect(snap(rig).duration.exhausted).toBe(false);
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.PAUSED);
  });

  test("14. pending transcription continues while paused, with no microphone", async () => {
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const transcribe = jest.fn(async () => {
      await gate;
      return WORDS;
    });
    const rig = buildEngine({ transcribe });
    await begin(rig);
    rig.advance(30000);
    rig.roll();
    await settle();
    await rig.engine.pause();
    await settle();
    // Two chunks sealed, none transcribed yet; the meeting is paused.
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(snap(rig).pending).toBe(2);
    expect(currentMicrophoneOwner()).toBeNull();

    release();
    await drain(rig);
    await drain(rig);
    expect(snap(rig).pending).toBe(0);
    expect(snap(rig).chunks.every((c) => c.state === CHUNK_STATE.TRANSCRIBED)).toBe(true);
    // Still paused, still the active meeting, still no microphone.
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(snap(rig).active).toBe(true);
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("15. Pause does not run the meeting's completion — no consolidation, no `finished`", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    await rig.engine.pause();
    await settle();
    await drain(rig);
    await drain(rig);

    const s = snap(rig);
    expect(s.session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(s.session.stoppedAt).toBeNull();
    expect(s.session.stopReason).toBeNull();
    expect(s.summary.final).toBe(false);
    // No FINAL or MERGE request was ever made.
    expect(rig.summarise.mock.calls.every(([r]) => r.mode === "window")).toBe(true);
    expect(s.summaryCoverage.complete).toBe(false);
  });

  test("Pause is not an interruption: no error, no interruption reason", async () => {
    const rig = buildEngine();
    await begin(rig);
    await rig.engine.pause();
    await settle();
    expect(snap(rig).error).toBeNull();
    expect(snap(rig).session.stopReason).toBeNull();
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.PAUSED);
  });

  test("Pause on a meeting that is not recording is a no-op", async () => {
    const rig = buildEngine();
    await begin(rig);
    await rig.engine.pause();
    await settle();
    const paused = snap(rig).session;
    await rig.engine.pause();
    await settle();
    expect(snap(rig).session).toEqual(paused);
  });
});

/* ============================== 16–21. RESUME ============================ */

describe("Resume reopens the microphone into the SAME meeting", () => {
  test("16/17/18/19/20. Resume: same id, next sequence, transcript, summary, microphone reacquired", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    await rig.engine.pause();
    await settle();
    await drain(rig);
    const paused = snap(rig);
    const nextSeq = paused.session.nextSeq;
    const revision = paused.summary.revision;
    expect(rig.getUserMedia).toHaveBeenCalledTimes(1);

    rig.advance(HOUR);
    await rig.engine.resume();
    await settle();

    const resumed = snap(rig);
    expect(resumed.session.sessionId).toBe(paused.session.sessionId);
    expect(resumed.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    // 20. the microphone was reacquired, once.
    expect(rig.getUserMedia).toHaveBeenCalledTimes(2);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(rig.rolling()).toBe(true);
    // 18/19. nothing was reset.
    expect(resumed.chunks.map((c) => c.text)).toEqual(paused.chunks.map((c) => c.text));
    expect(resumed.summary.revision).toBe(revision);
    expect(resumed.summary.parts.length).toBe(paused.summary.parts.length);
    // 17. the next chunk takes the next sequence.
    rig.advance(30000);
    await speak(rig);
    expect(snap(rig).chunks.map((c) => c.seq)).toEqual([...paused.chunks.map((c) => c.seq), nextSeq]);
  });

  test("21. the remaining budget after a pause is the budget less what was actually recorded", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(90 * MINUTE);
    await rig.engine.pause();
    await settle();
    rig.advance(3 * HOUR);
    await rig.engine.resume();
    await settle();
    const status = snap(rig).duration;
    expect(status.capturedMs).toBe(90 * MINUTE);
    expect(status.remainingMs).toBe(LISTEN_IN_MAX_CAPTURE_MS - 90 * MINUTE);
    expect(status.shouldWarn).toBe(false);
  });

  test("a pause/resume cycle does not duplicate or reset summary revisions", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const calls = rig.summarise.mock.calls.length;
    const revision = snap(rig).summary.revision;
    for (let i = 0; i < 3; i += 1) {
      await rig.engine.pause();
      await settle();
      await drain(rig);
      await rig.engine.resume();
      await settle();
      await drain(rig);
    }
    expect(rig.summarise.mock.calls.length).toBe(calls);
    expect(snap(rig).summary.revision).toBe(revision);
  });
});

/* ============================ 22–30. COMPLETE ============================ */

describe("Complete meeting ends the meeting and keeps the record", () => {
  test("22/25/26/27. Complete while recording seals, stops, drains, finalises and marks completed", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const sealedBefore = snap(rig).chunks.length;

    rig.advance(10000);
    await rig.engine.complete();
    await settle();
    expect(snap(rig).chunks.length).toBe(sealedBefore + 1);
    expect(currentMicrophoneOwner()).toBeNull();
    expect(rig.tracks[0].stop).toHaveBeenCalled();
    expect(snap(rig).session.stopReason).toBe(LISTEN_IN_STOP_REASON.USER);

    await drain(rig);
    await drain(rig);
    const s = snap(rig);
    expect(s.pending).toBe(0);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(s.summary.final).toBe(true);
    expect(rig.summarise.mock.calls.some(([r]) => r.mode === "final")).toBe(true);
    // 28. no longer the active meeting.
    expect(s.active).toBe(false);
  });

  test("23. Complete while PAUSED never reopens the microphone", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    await rig.engine.pause();
    await settle();
    expect(rig.getUserMedia).toHaveBeenCalledTimes(1);

    await rig.engine.complete();
    await settle();
    await drain(rig);
    await drain(rig);

    expect(rig.getUserMedia).toHaveBeenCalledTimes(1);
    expect(currentMicrophoneOwner()).toBeNull();
    const s = snap(rig);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(s.summary.final).toBe(true);
    expect(s.active).toBe(false);
    expect(s.session.stopReason).toBe(LISTEN_IN_STOP_REASON.USER);
  });

  test("24/34. Complete while INTERRUPTED never reopens the microphone, and finalises what was recovered", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    rig.roll();
    await settle();
    // The process dies with the header saying `recording`.
    await store.putSession({ ...snap(rig).session, state: LISTEN_IN_STATE.RECORDING });
    crash();

    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    expect(snap(second).session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(snap(second).session.stopReason).toBe(LISTEN_IN_STOP_REASON.INTERRUPTION);

    await second.engine.complete();
    await settle();
    await drain(second);
    await drain(second);

    expect(second.getUserMedia).not.toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBeNull();
    const s = snap(second);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(s.chunks.every((c) => c.state === CHUNK_STATE.TRANSCRIBED)).toBe(true);
    expect(s.summary.final).toBe(true);
    expect(s.active).toBe(false);
    // The interruption stays on record as why capture ended.
    expect(s.session.stopReason).toBe(LISTEN_IN_STOP_REASON.INTERRUPTION);
  });

  test("29. Complete does NOT delete the meeting: header, chunks and summary all remain in the store", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const id = snap(rig).session.sessionId;
    await rig.engine.complete();
    await settle();
    await drain(rig);
    await drain(rig);

    const header = await store.getSession(UID, WS, id);
    expect(header.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect((await store.listChunks(UID, WS, id)).length).toBe(2);
    expect((await store.getSummary(UID, WS, id)).final).toBe(true);
    // And the engine still shows it for review and export.
    expect(snap(rig).session.sessionId).toBe(id);
    expect(snap(rig).chunks.length).toBe(2);
    expect(snap(rig).summary.final).toBe(true);
  });

  test("30. the next Start creates a NEW meeting with a new id, and the old record is untouched", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const first = snap(rig).session.sessionId;
    await rig.engine.complete();
    await settle();
    await drain(rig);
    await drain(rig);

    rig.advance(MINUTE);
    await rig.engine.start({ language: "en" });
    await settle();
    const s = snap(rig);
    expect(s.session.sessionId).not.toBe(first);
    expect(s.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(s.session.nextSeq).toBe(0);
    expect(s.chunks).toEqual([]);
    expect(s.summary.parts).toEqual([]);
    expect(s.duration.capturedMs).toBe(0);
    expect(s.active).toBe(true);
    // Meeting A is still in the store, completed, with everything it had.
    expect((await store.getSession(UID, WS, first)).state).toBe(LISTEN_IN_STATE.FINISHED);
    expect((await store.listChunks(UID, WS, first)).length).toBe(2);
    expect((await store.listSessions(UID, WS)).length).toBe(2);
  });

  test("Complete on a completed meeting is a no-op", async () => {
    const rig = buildEngine();
    await begin(rig);
    await rig.engine.complete();
    await settle();
    await drain(rig);
    const done = snap(rig);
    await rig.engine.complete();
    await settle();
    expect(snap(rig)).toBe(done);
  });
});

/* ============================ 31–35. RECOVERY ============================ */

describe("a crash recovers the same unfinished meeting, and nothing starts another over it", () => {
  test("31/32/33. reload recovers Meeting A as interrupted, and Resume continues it", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    const id = snap(rig).session.sessionId;
    const nextSeq = snap(rig).session.nextSeq;
    await store.putSession({ ...snap(rig).session, state: LISTEN_IN_STATE.RECORDING });
    crash();

    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    let s = snap(second);
    // 31. the SAME meeting, interrupted.
    expect(s.session.sessionId).toBe(id);
    expect(s.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(s.active).toBe(true);
    expect(s.chunks[0].text).toBe(WORDS);
    expect(s.summary.parts.length).toBeGreaterThan(0);
    // 32. Resume and Complete are both possible.
    expect(s.duration.exhausted).toBe(false);

    // 33. Resume continues it.
    await second.engine.resume();
    await settle();
    s = snap(second);
    expect(s.session.sessionId).toBe(id);
    expect(s.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(second.getUserMedia).toHaveBeenCalledTimes(1);
    second.advance(30000);
    await speak(second);
    expect(snap(second).chunks.map((c) => c.seq)).toEqual([0, nextSeq]);
  });

  test("a PAUSED meeting comes back paused after a reload — not interrupted, not an error", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    await rig.engine.pause();
    await settle();
    const id = snap(rig).session.sessionId;
    crash();

    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    const s = snap(second);
    expect(s.session.sessionId).toBe(id);
    expect(s.session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(s.session.stopReason).toBeNull();
    expect(s.error).toBeNull();
    expect(s.active).toBe(true);
  });

  test("35. Start over a recovered meeting is REFUSED — no second session is created", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    rig.advance(30000);
    rig.roll();
    await settle();
    const id = snap(rig).session.sessionId;
    await store.putSession({ ...snap(rig).session, state: LISTEN_IN_STATE.RECORDING });
    crash();

    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    await second.engine.start({ language: "en" });
    await settle();

    const s = snap(second);
    expect(s.session.sessionId).toBe(id);
    expect(s.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(s.error.message).toBe(LISTEN_IN_MESSAGE.MEETING_ACTIVE);
    expect(second.getUserMedia).not.toHaveBeenCalled();
    expect((await store.listSessions(UID, WS)).length).toBe(1);
  });
});

/* ========================== 36–38. ACTIVE MEETING ======================== */

describe("at most one active meeting per account and workspace, found deterministically", () => {
  test("36/37. the unfinished meeting is rediscovered, and a newer COMPLETED one is not mistaken for it", async () => {
    const store = createListenInMemoryStore();
    const T = 1_700_000_000_000;
    // An older meeting left paused, and a newer one that was completed.
    await store.putSession({
      uid: UID, workspaceId: WS, sessionId: "older-paused", title: "A",
      startedAt: T - 2 * HOUR, stoppedAt: null, capturedMs: 10 * MINUTE, legStartedAt: null,
      state: LISTEN_IN_STATE.PAUSED, stopReason: null, limitWarnedAt: null,
      language: "en", nextSeq: 3, updatedAt: T - HOUR,
    });
    await store.putSession({
      uid: UID, workspaceId: WS, sessionId: "newer-completed", title: "B",
      startedAt: T - 30 * MINUTE, stoppedAt: T - 10 * MINUTE, capturedMs: 20 * MINUTE, legStartedAt: null,
      state: LISTEN_IN_STATE.FINISHED, stopReason: LISTEN_IN_STOP_REASON.USER, limitWarnedAt: null,
      language: "en", nextSeq: 40, updatedAt: T - 10 * MINUTE,
    });

    const rig = buildEngine({ store });
    await rig.engine.bootstrap();
    await settle();
    expect(snap(rig).session.sessionId).toBe("older-paused");
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(snap(rig).active).toBe(true);
    // Two engines over the same store adopt the same meeting.
    const again = buildEngine({ store });
    await again.engine.bootstrap();
    await settle();
    expect(snap(again).session.sessionId).toBe("older-paused");
    // The completed record is still there, untouched.
    expect((await store.getSession(UID, WS, "newer-completed")).state).toBe(LISTEN_IN_STATE.FINISHED);
  });

  test("only completed meetings in the store means NO active meeting — Start begins a new one", async () => {
    const store = createListenInMemoryStore();
    const T = 1_700_000_000_000;
    await store.putSession({
      uid: UID, workspaceId: WS, sessionId: "done", title: "A",
      startedAt: T - HOUR, stoppedAt: T - 30 * MINUTE, capturedMs: 30 * MINUTE, legStartedAt: null,
      state: LISTEN_IN_STATE.FINISHED, stopReason: LISTEN_IN_STOP_REASON.USER, limitWarnedAt: null,
      language: "en", nextSeq: 60, updatedAt: T - 30 * MINUTE,
    });
    const rig = buildEngine({ store });
    await rig.engine.bootstrap();
    await settle();
    expect(snap(rig).session).toBeNull();
    expect(snap(rig).active).toBe(false);
    await rig.engine.start({ language: "en" });
    await settle();
    expect(snap(rig).session.sessionId).not.toBe("done");
    expect(snap(rig).active).toBe(true);
  });

  test("two open headers (an earlier build could leave them) resolve the same way every time", async () => {
    const store = createListenInMemoryStore();
    const T = 1_700_000_000_000;
    for (const id of ["b-open", "a-open"]) {
      await store.putSession({
        uid: UID, workspaceId: WS, sessionId: id, title: id,
        startedAt: T, stoppedAt: null, capturedMs: 0, legStartedAt: null,
        state: LISTEN_IN_STATE.INTERRUPTED, stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
        limitWarnedAt: null, language: "en", nextSeq: 0, updatedAt: T,
      });
    }
    const first = buildEngine({ store });
    await first.engine.bootstrap();
    await settle();
    const second = buildEngine({ store });
    await second.engine.bootstrap();
    await settle();
    expect(snap(first).session.sessionId).toBe("a-open");
    expect(snap(second).session.sessionId).toBe("a-open");
  });

  test("38. Start is refused while a meeting is recording, paused, interrupted or completing", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine({ store });
    await begin(rig);
    const id = snap(rig).session.sessionId;
    const refused = async () => {
      await rig.engine.start({ language: "en" });
      await settle();
      expect(snap(rig).session.sessionId).toBe(id);
      expect(snap(rig).error.message).toBe(LISTEN_IN_MESSAGE.MEETING_ACTIVE);
      expect((await store.listSessions(UID, WS)).length).toBe(1);
    };
    // recording
    await refused();
    // paused
    await rig.engine.pause();
    await settle();
    await refused();
    // completing (transcription never finishes, so it stays `finishing`)
    const stuck = buildEngine({ store: createListenInMemoryStore(), transcribe: () => new Promise(() => {}) });
    await begin(stuck);
    stuck.advance(30000);
    await stuck.engine.complete();
    await settle();
    expect(snap(stuck).session.state).toBe(LISTEN_IN_STATE.FINISHING);
    const stuckId = snap(stuck).session.sessionId;
    await stuck.engine.start({ language: "en" });
    await settle();
    expect(snap(stuck).session.sessionId).toBe(stuckId);
    expect(snap(stuck).error.message).toBe(LISTEN_IN_MESSAGE.MEETING_ACTIVE);
  });
});

/* ============================ 39–41. FOUR HOURS ========================== */

describe("the four-hour budget is per meeting and survives pause/resume", () => {
  test("39. pause/resume cannot reset the budget — 3 h 59 m paused then resumed stops after one minute", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS - MINUTE);
    rig.roll();
    await settle();
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.RECORDING);
    await rig.engine.pause();
    await settle();
    expect(snap(rig).session.capturedMs).toBe(LISTEN_IN_MAX_CAPTURE_MS - MINUTE);

    // Paused overnight. Resume is still allowed: one minute is left.
    rig.advance(10 * HOUR);
    await rig.engine.resume();
    await settle();
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap(rig).duration.remainingMs).toBe(MINUTE);

    // One minute later the armed wake-up stops it, exactly once.
    rig.advance(MINUTE);
    rig.fireTimers();
    rig.roll();
    rig.wake();
    await settle();
    const s = snap(rig);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(s.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    expect(s.session.capturedMs).toBe(LISTEN_IN_MAX_CAPTURE_MS);
    expect(rig.tracks[0].stop).toHaveBeenCalledTimes(2); // once per leg
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("40. Resume is refused for a paused meeting whose budget is spent", async () => {
    const store = createListenInMemoryStore();
    const T = 1_700_000_000_000;
    await store.putSession({
      uid: UID, workspaceId: WS, sessionId: "spent", title: "A",
      startedAt: T - 5 * HOUR, stoppedAt: null, capturedMs: LISTEN_IN_MAX_CAPTURE_MS, legStartedAt: null,
      state: LISTEN_IN_STATE.PAUSED, stopReason: null, limitWarnedAt: T - 3 * HOUR,
      language: "en", nextSeq: 480, updatedAt: T - HOUR,
    });
    const rig = buildEngine({ store });
    await rig.engine.bootstrap();
    await settle();
    await rig.engine.resume();
    await settle();
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(snap(rig).error.message).toBe(LISTEN_IN_MESSAGE.LIMIT_EXHAUSTED);
    expect(rig.getUserMedia).not.toHaveBeenCalled();
    // Complete is still available and finalises it.
    await rig.engine.complete();
    await settle();
    await drain(rig);
    expect(snap(rig).session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(rig.getUserMedia).not.toHaveBeenCalled();
  });

  test("41. the hard stop still happens exactly once and completes the meeting", async () => {
    const rig = buildEngine();
    await begin(rig);
    rig.advance(30000);
    await speak(rig);
    rig.advance(LISTEN_IN_MAX_CAPTURE_MS);
    rig.roll();
    rig.wake();
    rig.fireTimers();
    rig.roll();
    await settle();
    expect(rig.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(snap(rig).session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    await drain(rig);
    await drain(rig);
    const s = snap(rig);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(s.summary.final).toBe(true);
    expect(s.active).toBe(false);
    // And the next Start is a new meeting.
    await rig.engine.start({ language: "en" });
    await settle();
    expect(snap(rig).session.sessionId).not.toBe(s.session.sessionId);
  });
});
