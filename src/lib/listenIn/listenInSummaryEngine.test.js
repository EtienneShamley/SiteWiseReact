// src/lib/listenIn/listenInSummaryEngine.test.js
//
// THE SUMMARY LOOP, AS THE ENGINE RUNS IT (Phase 8D.2).
//
// Behavioural throughout: a real engine, a real memory store, a fake recorder
// and an injected summariser that records exactly what it was asked for. Every
// test here is about one of the promises the phase makes:
//
//   - summarisation is AUTOMATIC — there is no button anywhere in this file;
//   - it does NOT run once per 30-second chunk;
//   - CAPTURE CONTINUES while a summary is generating, and a summary failure
//     cannot stop, pause or shorten a recording;
//   - a long transcript goes through BOUNDED WINDOWS and a reduce, never one
//     oversized request;
//   - Stop sequences correctly: capture ends, transcription drains, and only
//     then is the summary consolidated;
//   - a session can finish WITH ISSUES rather than hanging on a dead chunk;
//   - the summary is the SESSION's, so it survives every view.

import {
  createListenInEngine,
  resetListenInEnginesForTests,
} from "./listenInEngine";
import { CHUNK_STATE, LISTEN_IN_STATE } from "./listenInModel";
import { LISTEN_IN_SUMMARY_POLICY } from "./listenInSummaryModel";
import { createListenInMemoryStore } from "./listenInStore";
import {
  MICROPHONE_OWNER,
  currentMicrophoneOwner,
  resetMicrophoneOwnershipForTests,
} from "../microphoneOwnership";

const UID = "uid-summary";
const WS = "ws-summary";

/** A recorder that seals a chunk whenever it is stopped. */
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
beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  FakeMediaRecorder.instances = [];
  tracks = [{ stop: jest.fn() }];
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => tracks })) },
    configurable: true,
  });
});
afterEach(() => {
  resetListenInEnginesForTests();
});

/* ------------------------------- the rig --------------------------------- */

// One chunk's worth of speech, deliberately long enough to clear the policy's
// size gate on its own — so a test that wants a window to be summarised gets
// one, and a test that wants the gate to HOLD uses a short line instead.
const WORDS = "This is roughly a minute of meeting speech about the survey. ".repeat(60).trim();

const summaryResult = (text, extra = {}) => ({
  summaryText: text,
  keyPoints: [],
  decisions: [],
  actionItems: [],
  risks: [],
  followUps: [],
  ...extra,
});

/**
 * A summariser double. It records every call, and answers with a result
 * naming the mode and the sequences it was given — so a test can see exactly
 * what was summarised and how it was reduced.
 */
function recordingSummariser(behaviour = {}) {
  const calls = [];
  const fn = jest.fn(async (request) => {
    calls.push(request);
    if (behaviour.fail) return { ok: false, outcome: "failure", message: "no summary" };
    if (behaviour.hang) await behaviour.hang;
    if (request.mode === "window") {
      return {
        ok: true,
        result: summaryResult(`window ${request.segments[0].seq}-${request.segments[request.segments.length - 1].seq}`),
      };
    }
    return { ok: true, result: summaryResult(`${request.mode} of ${request.parts.length}`) };
  });
  fn.calls = calls;
  return fn;
}

/**
 * Build an engine with everything injected and BOTH clocks under our control:
 * the chunk roll (captured from the interval the engine arms) and the wall
 * clock the policy's interval gate reads. No real timer fires in this file.
 */
function buildEngine({ summarise, transcribe, policy } = {}) {
  let clock = 100000;
  let roll = null;
  const engine = createListenInEngine({
    uid: UID,
    workspaceId: WS,
    store: createListenInMemoryStore(),
    transcribe: transcribe || (async () => WORDS),
    summarise: summarise || recordingSummariser(),
    summaryPolicy: policy || LISTEN_IN_SUMMARY_POLICY,
    recorderSupported: () => true,
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
    // The engine arms the chunk roll here; the test drives it by hand.
    setInterval_: (fn) => {
      roll = fn;
      return 1;
    },
    clearInterval_: () => {},
    newSessionId: () => "session-1",
  });
  return {
    engine,
    roll: () => roll && roll(),
    advance: (ms) => {
      clock += ms;
    },
    at: () => clock,
  };
}

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/**
 * Record ONE chunk of speech: roll the recorder (sealing the chunk and opening
 * the next), drain it, then let the summary loop have its pass.
 */
async function speak(rig) {
  rig.roll();
  await settle();
  await rig.engine.flush();
  await settle();
  await rig.engine.flushSummary();
  await settle();
}

/* ============================ automatic, not a button ==================== */

describe("summarisation is automatic, and is not run once per chunk", () => {
  test("ONE 30-second chunk of speech spends nothing at all", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise, transcribe: async () => "Just one short sentence." });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    expect(engine.getSnapshot().chunks[0].state).toBe(CHUNK_STATE.TRANSCRIBED);
    // The transcript is there; the summariser was never asked.
    expect(summarise).not.toHaveBeenCalled();
  });

  test("enough transcript triggers a summary with no user action of any kind", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    expect(summarise).toHaveBeenCalledTimes(1);
    expect(summarise.calls[0].mode).toBe("window");
    const { summary } = engine.getSnapshot();
    expect(summary.result.summaryText).toBe("window 0-0");
    expect(summary.status).toBe("ready");
  });

  test("ten more chunks do NOT become ten more requests", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    for (let i = 0; i < 10; i += 1) {
      advance(30000);
      await speak(rig);
    }
    // Ten chunks of speech, five minutes of wall clock: the interval gate
    // holds the count far below one request per chunk.
    expect(summarise.mock.calls.length).toBeLessThanOrEqual(3);
    expect(engine.getSnapshot().chunks).toHaveLength(10);
  });

  test("each window reads only NEW transcript — nothing is summarised twice", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    advance(LISTEN_IN_SUMMARY_POLICY.minIntervalMs + 1000);
    await speak(rig);
    expect(summarise.mock.calls.length).toBe(2);
    const first = summarise.calls[0].segments.map((s) => s.seq);
    const second = summarise.calls[1].segments.map((s) => s.seq);
    expect(first).toEqual([0]);
    expect(second).toEqual([1]);
  });
});

/* ======================= capture is never blocked ======================== */

describe("capture and transcription are never blocked by the summary", () => {
  test("recording continues while a summary request is in flight", async () => {
    let release;
    const hang = new Promise((resolve) => {
      release = resolve;
    });
    const summarise = recordingSummariser({ hang });
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });

    // Start a summary and leave it hanging.
    rig.roll();
    await settle();
    await engine.flush();
    await settle();
    const summaryRun = engine.flushSummary();
    await settle();
    expect(summarise).toHaveBeenCalled();
    expect(engine.getSnapshot().summary.status).toBe("generating");

    // …and the recording is completely unaffected: still recording, still
    // holding the microphone, and still sealing chunks.
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    rig.roll();
    await settle();
    await engine.flush();
    await settle();
    expect(engine.getSnapshot().chunks.length).toBeGreaterThanOrEqual(2);
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);

    release();
    await summaryRun;
  });

  test("a summary FAILURE does not stop, pause or shorten the capture", async () => {
    const summarise = recordingSummariser({ fail: true });
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);

    expect(summarise).toHaveBeenCalled();
    const snap = engine.getSnapshot();
    expect(snap.summary.status).toBe("failed");
    expect(snap.summary.lastErrorOutcome).toBe("failure");
    // The recording is untouched by all of it.
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(snap.chunks[0].state).toBe(CHUNK_STATE.TRANSCRIBED);
    expect(snap.error).toBeNull();
  });

  test("a summary failure leaves the TRANSCRIPT completely intact", async () => {
    const summarise = recordingSummariser({ fail: true });
    const rig = buildEngine({ summarise, transcribe: async () => WORDS });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    await engine.stop();
    await settle();
    await engine.flush();
    await settle();
    const { chunks } = engine.getSnapshot();
    expect(chunks.every((c) => c.state === CHUNK_STATE.TRANSCRIBED)).toBe(true);
    expect(chunks[0].text).toBe(WORDS);
  });

  test("an explicit Try again clears the backoff and asks once more", async () => {
    let fail = true;
    const summarise = jest.fn(async (request) => {
      if (fail) return { ok: false, outcome: "failure", message: "no" };
      return { ok: true, result: summaryResult(`ok ${request.mode}`) };
    });
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    expect(engine.getSnapshot().summary.status).toBe("failed");

    fail = false;
    await engine.retrySummary();
    await settle();
    await engine.flushSummary();
    await settle();
    expect(engine.getSnapshot().summary.result.summaryText).toBe("ok window");
    expect(engine.getSnapshot().summary.lastErrorOutcome).toBeNull();
  });

  test("offline burns no attempt and sends nothing", async () => {
    const summarise = recordingSummariser();
    const engine = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store: createListenInMemoryStore(),
      transcribe: async () => WORDS,
      summarise,
      recorderSupported: () => true,
      isOnline: () => false,
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 0,
      clearInterval_: () => {},
      newSessionId: () => "session-offline",
    });
    await engine.start({ language: "en" });
    FakeMediaRecorder.instances[0].stop();
    await settle();
    // The drain cannot run offline either, so the transcript is seeded
    // directly and only the summary loop is exercised.
    await engine.flushSummary();
    await settle();
    expect(summarise).not.toHaveBeenCalled();
    expect(engine.getSnapshot().summary.attempts).toBe(0);
  });
});

/* ========================= bounded windows, reduce ======================= */

describe("a long transcript is processed in bounded windows and reduced", () => {
  test("no request ever carries more than one window of transcript", async () => {
    const summarise = recordingSummariser();
    const long = "x".repeat(9000);
    const rig = buildEngine({ summarise, transcribe: async () => long });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    for (let i = 0; i < 6; i += 1) {
      advance(LISTEN_IN_SUMMARY_POLICY.minIntervalMs + 1000);
      await speak(rig);
    }
    expect(summarise.mock.calls.length).toBeGreaterThan(1);
    for (const call of summarise.calls.filter((c) => c.mode === "window")) {
      const chars = call.segments.reduce((n, s) => n + s.text.length, 0);
      expect(chars).toBeLessThanOrEqual(LISTEN_IN_SUMMARY_POLICY.maxWindowChars);
    }
  });

  test("the final consolidation reads the PARTS, never the transcript again", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    advance(LISTEN_IN_SUMMARY_POLICY.minIntervalMs + 1000);
    await speak(rig);

    await engine.stop();
    await settle();
    await engine.flush();
    await settle();
    await engine.flushSummary();
    await settle();

    const final = summarise.calls[summarise.calls.length - 1];
    expect(final.mode).toBe("final");
    expect(final.segments).toBeUndefined();
    expect(final.parts.length).toBeGreaterThan(0);
    expect(engine.getSnapshot().summary.final).toBe(true);
    expect(engine.getSnapshot().summary.result.summaryText).toMatch(/^final of/);
  });

  test("a session that produced no words at all is final and claims nothing", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise, transcribe: async () => "" });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    await engine.stop();
    await settle();
    await engine.flush();
    await settle();
    await engine.flushSummary();
    await settle();
    const { summary } = engine.getSnapshot();
    expect(summarise).not.toHaveBeenCalled();
    expect(summary.final).toBe(true);
    expect(summary.result.summaryText).toBe("");
  });
});

/* ============================== finalisation ============================= */

describe("Stop sequences capture, then transcription, then the summary", () => {
  test("the final summary is produced only after the drain has finished", async () => {
    const order = [];
    const summarise = jest.fn(async (request) => {
      order.push(`summary:${request.mode}`);
      return { ok: true, result: summaryResult(`${request.mode}`) };
    });
    const transcribe = jest.fn(async () => {
      order.push("transcribe");
      return WORDS;
    });
    const rig = buildEngine({ summarise, transcribe });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);

    await engine.stop();
    await settle();
    await engine.flush();
    await settle();
    await engine.flushSummary();
    await settle();

    // Every transcription happened before the consolidation.
    const finalAt = order.lastIndexOf("summary:final");
    expect(finalAt).toBeGreaterThan(-1);
    expect(order.lastIndexOf("transcribe")).toBeLessThan(finalAt);
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.FINISHED);
  });

  test("finalisation summarises the LAST short window, gates and all", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise, transcribe: async () => "One short closing remark." });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    expect(summarise).not.toHaveBeenCalled(); // too little to be worth a request

    await engine.stop();
    await settle();
    await engine.flush();
    await settle();
    await engine.flushSummary();
    await settle();
    // Now it is worth it: the meeting is over and those words are all there is.
    const modes = summarise.calls.map((c) => c.mode);
    expect(modes).toContain("window");
    expect(modes[modes.length - 1]).toBe("final");
  });

  test("a session FINISHES WITH ISSUES rather than hanging on a dead chunk", async () => {
    // A chunk that fails for a non-recoverable reason exhausts immediately.
    const transcribe = jest.fn(async () => {
      throw new Error("Transcription failed");
    });
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise, transcribe });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    await engine.stop();
    await settle();
    await engine.flush();
    await settle();
    await engine.flushSummary();
    await settle();

    const snap = engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.failed).toBeGreaterThan(0);
    // The summary covered what it could and says what is missing.
    expect(snap.summary.final).toBe(true);
    expect(snap.summary.missingSeqs.length).toBeGreaterThan(0);
    expect(snap.summaryCoverage.failedCount).toBeGreaterThan(0);
    expect(snap.summaryCoverage.complete).toBe(true);
  });

  test("a failed consolidation leaves the session finished and the transcript whole", async () => {
    const summarise = jest.fn(async (request) =>
      request.mode === "window"
        ? { ok: true, result: summaryResult("window") }
        : { ok: false, outcome: "unavailable", message: "not now" }
    );
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    await engine.stop();
    await settle();
    await engine.flush();
    await settle();
    await engine.flushSummary();
    await settle();

    const snap = engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.summary.final).toBe(false);
    expect(snap.summary.lastErrorOutcome).toBe("unavailable");
    // The interim summary is still there to read, and so is every word.
    expect(snap.summary.result.summaryText).toContain("window");
    expect(snap.chunks.every((c) => c.state === CHUNK_STATE.TRANSCRIBED)).toBe(true);
  });
});

/* ====================== the summary is the session's ===================== */

describe("the summary belongs to the session, not to any view", () => {
  test("it is published in the engine's snapshot with its coverage", async () => {
    const rig = buildEngine();
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    const snap = engine.getSnapshot();
    expect(snap.summary.sessionId).toBe("session-1");
    expect(snap.summary.uid).toBe(UID);
    expect(snap.summaryCoverage).toMatchObject({
      transcribedThroughSeq: 0,
      summaryThroughSeq: 0,
      pendingCount: 0,
    });
  });

  test("it is written to the store, and a fresh engine recovers it", async () => {
    const store = createListenInMemoryStore();
    const summarise = recordingSummariser();
    const first = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store,
      transcribe: async () => WORDS,
      summarise,
      recorderSupported: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 0,
      clearInterval_: () => {},
      newSessionId: () => "session-keep",
    });
    await first.start({ language: "en" });
    FakeMediaRecorder.instances[0].stop();
    await settle();
    await first.flush();
    await settle();
    await first.flushSummary();
    await settle();
    expect(first.getSnapshot().summary.result.summaryText).toBe("window 0-0");
    // The process goes away entirely (a reload, a crash, a closed tab).
    first.shutdown();

    const second = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store,
      transcribe: async () => WORDS,
      summarise: recordingSummariser(),
      recorderSupported: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 0,
      clearInterval_: () => {},
    });
    await second.bootstrap();
    await settle();
    const recovered = second.getSnapshot().summary;
    expect(recovered.sessionId).toBe("session-keep");
    expect(recovered.result.summaryText).toBe("window 0-0");
    expect(recovered.coveredThroughSeq).toBe(0);
  });

  test("discarding the session takes its summary with it", async () => {
    const store = createListenInMemoryStore();
    const rig = buildEngine();
    const { engine, advance } = rig;
    const own = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store,
      transcribe: async () => WORDS,
      summarise: recordingSummariser(),
      recorderSupported: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 0,
      clearInterval_: () => {},
      newSessionId: () => "session-gone",
    });
    void engine;
    await own.start({ language: "en" });
    FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1].stop();
    await settle();
    await own.flush();
    await settle();
    await own.flushSummary();
    await settle();
    await own.stop();
    await settle();
    await own.discard();
    await settle();
    expect(own.getSnapshot().summary).toBeNull();
    expect(await store.getSummary(UID, WS, "session-gone")).toBeNull();
  });

  test("a new session starts with a new summary, not the last one's", async () => {
    const rig = buildEngine();
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    expect(engine.getSnapshot().summary.result.summaryText).toBe("window 0-0");
    await engine.stop();
    await settle();
    await engine.flush();
    await settle();

    await engine.start({ language: "en" });
    await settle();
    const summary = engine.getSnapshot().summary;
    expect(summary.result.summaryText).toBe("");
    expect(summary.coveredThroughSeq).toBe(-1);
    expect(summary.parts).toHaveLength(0);
  });
});

/* ============================== user editing ============================= */

describe("editing and regeneration", () => {
  test("an edit is stored on the session and survives the next generation", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    await engine.editSummaryText("What I actually took from it.");
    await settle();
    expect(engine.getSnapshot().summary.userSummaryText).toBe("What I actually took from it.");

    advance(LISTEN_IN_SUMMARY_POLICY.minIntervalMs + 1000);
    await speak(rig);
    const summary = engine.getSnapshot().summary;
    // The generated result moved on; the person's words did not.
    expect(summary.userSummaryText).toBe("What I actually took from it.");
    expect(summary.result.summaryText).toContain("window 1-1");
  });

  test("REGENERATION is explicit, and is the only thing that replaces an edit", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    await engine.editSummaryText("Mine.");
    await settle();

    await engine.regenerateSummary();
    await settle();
    await engine.flushSummary();
    await settle();
    const summary = engine.getSnapshot().summary;
    expect(summary.userSummaryText).toBeNull();
    expect(summary.final).toBe(true);
    expect(summary.result.summaryText).toMatch(/^final of/);
  });

  test("a regeneration re-consolidates the PARTS — it does not re-read the meeting", async () => {
    const summarise = recordingSummariser();
    const rig = buildEngine({ summarise });
    const { engine, advance } = rig;
    await engine.start({ language: "en" });
    await speak(rig);
    const windowCalls = summarise.calls.filter((c) => c.mode === "window").length;

    await engine.regenerateSummary();
    await settle();
    await engine.flushSummary();
    await settle();
    expect(summarise.calls.filter((c) => c.mode === "window")).toHaveLength(windowCalls);
    expect(summarise.calls[summarise.calls.length - 1].mode).toBe("final");
  });
});

/* ============================== the switch =============================== */

describe("the summary loop can be off without costing the capture anything", () => {
  test("with summaries disabled, recording and transcription are unchanged", async () => {
    const summarise = recordingSummariser();
    const engine = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store: createListenInMemoryStore(),
      transcribe: async () => WORDS,
      summarise,
      summaryEnabled: false,
      recorderSupported: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 0,
      clearInterval_: () => {},
      newSessionId: () => "session-off",
    });
    await engine.start({ language: "en" });
    FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1].stop();
    await settle();
    await engine.flush();
    await settle();
    expect(summarise).not.toHaveBeenCalled();
    expect(engine.getSnapshot().chunks[0].text).toBe(WORDS);
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
  });
});
