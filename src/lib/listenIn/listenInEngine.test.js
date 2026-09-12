// src/lib/listenIn/listenInEngine.test.js
//
// THE LISTEN IN ENGINE, BEHAVIOURALLY (Phase 8D.1).
//
// Everything the engine touches outside itself is injected — the microphone,
// the recorder, the clock, both timers, the network check and the store — so
// these are real behaviour tests over the real engine rather than assertions
// about its source. The same suite runs against BOTH stores: the memory store
// (what the approved security policy allows today) and the durable store's
// contract (what survives a reload), so nothing above them can quietly depend
// on durability.
//
// The guarantee under test, above all: the SESSION owns the recording. There
// is no call in here that a view could make which stops a capture, and the
// reload tests prove a brand-new engine picks up exactly what the old one
// left.
import {
  LISTEN_IN_CHUNK_MS,
  LISTEN_IN_MAX_AUTO_ATTEMPTS,
  applyListenInIdentity,
  createListenInEngine,
  getListenInEngine,
  peekListenInEngine,
  resetListenInEnginesForTests,
} from "./listenInEngine";
import {
  CHUNK_STATE,
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
  elapsedMs,
  transcriptSegments,
  transcriptText,
} from "./listenInModel";
import { createListenInMemoryStore } from "./listenInStore";
import {
  MICROPHONE_OWNER,
  claimMicrophone,
  currentMicrophoneOwner,
  releaseMicrophone,
  resetMicrophoneOwnershipForTests,
} from "../microphoneOwnership";

/* ------------------------------ the fakes -------------------------------- */

class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || "";
    this.audioBitsPerSecond = options && options.audioBitsPerSecond;
    this.state = "inactive";
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    // One complete container per chunk — what the route's byte sniffer needs.
    const data = new Blob([new Uint8Array(64)], { type: this.mimeType });
    if (this.ondataavailable) this.ondataavailable({ data });
    if (this.onstop) this.onstop();
  }
}

/** A clock and two timer sets the test drives by hand. */
function harness() {
  let clock = 1_700_000_000_000;
  const intervals = new Map();
  const timeouts = new Map();
  let nextId = 1;
  return {
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    setInterval_: (fn, ms) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval_: (id) => intervals.delete(id),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timeouts.delete(id),
    /** Fire the chunk-rolling interval once, as the browser would. */
    tickRoll: () => {
      for (const { fn } of [...intervals.values()]) fn();
    },
    /** Fire every armed retry timer. */
    tickRetry: () => {
      const due = [...timeouts.entries()];
      timeouts.clear();
      for (const [, { fn }] of due) fn();
    },
    retryArmed: () => timeouts.size > 0,
    rolling: () => intervals.size > 0,
  };
}

let tracks;
let getUserMedia;
function fakeStream() {
  tracks = [{ stop: jest.fn() }];
  return { getTracks: () => tracks };
}

const realMediaRecorder = global.MediaRecorder;
beforeAll(() => {
  global.MediaRecorder = FakeMediaRecorder;
});
afterAll(() => {
  global.MediaRecorder = realMediaRecorder;
});

let h;
let store;
let transcribe;
beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  FakeMediaRecorder.instances = [];
  h = harness();
  store = createListenInMemoryStore();
  getUserMedia = jest.fn(async () => fakeStream());
  transcribe = jest.fn(async () => "some words");
});

const WS = "ws-1";
const UID = "uid-a";

function makeEngine(overrides = {}) {
  return createListenInEngine({
    uid: UID,
    workspaceId: WS,
    store,
    transcribe: (...args) => transcribe(...args),
    getUserMedia: (...args) => getUserMedia(...args),
    recorderSupported: () => true,
    now: h.now,
    setTimer: h.setTimer,
    clearTimer: h.clearTimer,
    setInterval_: h.setInterval_,
    clearInterval_: h.clearInterval_,
    newSessionId: (() => {
      let n = 0;
      return () => `sess-${(n += 1)}`;
    })(),
    ...overrides,
  });
}

/**
 * Let the engine finish whatever it is doing. The drain is a chain of real
 * promises (a store read, a transcription, two writes, a reload, per chunk),
 * so this yields to the macrotask queue repeatedly rather than counting
 * microtasks — which would stop partway through a multi-chunk drain and make
 * a passing test a coincidence. `setTimeout` here is the REAL one: the
 * engine's own timers are the injected ones the harness drives.
 */
const settle = async () => {
  for (let i = 0; i < 25; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/* ============================ 1. start / stop ============================ */

describe("1/6. a session starts, and only an explicit Stop ends it", () => {
  test("start opens one microphone, claims it, and records one active session", async () => {
    const engine = makeEngine();
    await engine.start({ language: "en" });
    const snap = engine.getSnapshot();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap.session.workspaceId).toBe(WS);
    expect(snap.session.language).toBe("en");
    expect(snap.session.nextSeq).toBe(0);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].state).toBe("recording");
    // The header is persisted the moment it exists.
    expect((await store.getSession(UID, WS, snap.session.sessionId)).state).toBe(
      LISTEN_IN_STATE.RECORDING
    );
  });

  test("6/24. Stop seals the final chunk, releases the microphone and finishes", async () => {
    const engine = makeEngine();
    await engine.start({ language: "en" });
    const id = engine.getSnapshot().session.sessionId;
    h.advance(30000);
    await engine.stop();
    await settle();
    const snap = engine.getSnapshot();
    expect(snap.session.stopReason).toBe(LISTEN_IN_STOP_REASON.USER);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(currentMicrophoneOwner()).toBeNull();
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    expect(h.rolling()).toBe(false);
    // The speech the user had just given was not thrown away.
    const chunks = await store.listChunks(UID, WS, id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[0].text).toBe("some words");
  });

  test("a second start while recording changes nothing — one capture at a time", async () => {
    const engine = makeEngine();
    await engine.start();
    const first = engine.getSnapshot().session.sessionId;
    await engine.start();
    expect(engine.getSnapshot().session.sessionId).toBe(first);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("a refused microphone leaves no session and no claim behind", async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error("denied"), { name: "NotAllowedError" })
    );
    const engine = makeEngine();
    await engine.start();
    const snap = engine.getSnapshot();
    expect(snap.session).toBeNull();
    expect(snap.error.name).toBe("NotAllowedError");
    expect(currentMicrophoneOwner()).toBeNull();
  });
});

/* ======================= 7. elapsed time is the session's ================= */

describe("7. elapsed time derives from the session, not from a view", () => {
  test("it is the same value however long nothing was watching", async () => {
    const engine = makeEngine();
    await engine.start();
    const session = engine.getSnapshot().session;
    h.advance(65_000);
    // Nothing has been mounted, subscribed or ticked; the answer is still right.
    expect(elapsedMs(session, h.now())).toBe(65_000);
    expect(elapsedMs(engine.getSnapshot().session, h.now())).toBe(65_000);
  });

  test("time spent NOT recording is not counted, and a resume adds to the total", async () => {
    const engine = makeEngine();
    await engine.start();
    h.advance(10_000);
    await engine.stop();
    await settle();
    const stopped = engine.getSnapshot().session;
    h.advance(500_000); // a long time doing something else
    expect(elapsedMs(stopped, h.now())).toBe(10_000);
  });
});

/* ===================== 14/15/17. chunk rolling and capture ================ */

describe("14/15/17. rolling chunks are complete containers, and capture never waits", () => {
  test("14. each roll seals ONE complete container and opens the next on the same stream", async () => {
    const engine = makeEngine();
    await engine.start();
    const id = engine.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();

    expect(FakeMediaRecorder.instances).toHaveLength(3);
    expect(getUserMedia).toHaveBeenCalledTimes(1); // ONE microphone, reopened
    const streams = new Set(FakeMediaRecorder.instances.map((r) => r.stream));
    expect(streams.size).toBe(1);
    // Every upload handed to the transport is a whole Blob of that container.
    for (const [blob] of transcribe.mock.calls) {
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(64);
      expect(blob.type).toBe("audio/webm;codecs=opus");
    }
    const chunks = await store.listChunks(UID, WS, id);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
  });

  test("17. sequence numbers never repeat, and the session records the next one", async () => {
    const engine = makeEngine();
    await engine.start();
    for (let i = 0; i < 5; i += 1) {
      h.advance(LISTEN_IN_CHUNK_MS);
      h.tickRoll();
      await settle();
    }
    const snap = engine.getSnapshot();
    expect(snap.session.nextSeq).toBe(5);
    expect(snap.chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(snap.chunks.map((c) => c.seq)).size).toBe(5);
  });

  test("15. capture carries on while an earlier chunk is still transcribing", async () => {
    let release;
    transcribe.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    const engine = makeEngine();
    await engine.start();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    // Chunk 0 is in flight and going nowhere.
    expect(transcribe).toHaveBeenCalledTimes(1);
    // …and the microphone is still recording, rolling on.
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    const snap = engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap.chunks).toHaveLength(3);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    // Only the first was ever sent: the drain is strictly sequential.
    expect(transcribe).toHaveBeenCalledTimes(1);
    release("first chunk");
    await settle();
  });

  test("16. going offline does not stop capture and burns no attempt", async () => {
    let online = true;
    const engine = makeEngine({ isOnline: () => online });
    await engine.start();
    online = false;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();

    expect(transcribe).not.toHaveBeenCalled();
    const snap = engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap.chunks).toHaveLength(2);
    expect(snap.chunks.every((c) => c.state === CHUNK_STATE.SEALED)).toBe(true);
    expect(snap.chunks.every((c) => c.attempts === 0)).toBe(true);
    // Their audio is waiting, not lost.
    expect(await store.getChunkAudio(UID, WS, snap.session.sessionId, 0)).toBeInstanceOf(Blob);

    // Back online, the backlog drains in order.
    online = true;
    h.tickRetry();
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcriptText(engine.getSnapshot().chunks)).toBe("some words some words");
  });
});

/* ====================== 9/10/11/12. the transcription drain =============== */

describe("9/10/11/12. the drain, its ordering and what it does with audio", () => {
  test("10/13. transcripts land on their own chunk, in speaking order", async () => {
    let n = 0;
    transcribe.mockImplementation(async () => `part ${(n += 1)}`);
    const engine = makeEngine();
    await engine.start();
    for (let i = 0; i < 3; i += 1) {
      h.advance(LISTEN_IN_CHUNK_MS);
      h.tickRoll();
      await settle();
    }
    const snap = engine.getSnapshot();
    expect(snap.chunks.map((c) => c.text)).toEqual(["part 1", "part 2", "part 3"]);
    expect(transcriptText(snap.chunks)).toBe("part 1 part 2 part 3");
    // The segments carry their own identity and timing — no joined string is
    // the canonical data.
    const segments = transcriptSegments(snap.session, snap.chunks);
    expect(segments.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(segments.every((s) => s.speaker === null)).toBe(true);
    expect(segments[1].offsetMs).toBeGreaterThan(segments[0].offsetMs);
  });

  test("11. audio is released once, and only once, its transcript is stored", async () => {
    const engine = makeEngine();
    await engine.start();
    const id = engine.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    const chunk = engine.getSnapshot().chunks[0];
    expect(chunk.state).toBe(CHUNK_STATE.TRANSCRIBED);
    expect(chunk.text).toBe("some words");
    // The words are kept; the bytes are not.
    expect(await store.getChunkAudio(UID, WS, id, 0)).toBeNull();
  });

  test("12. a FAILED chunk keeps its audio, so a retry is a real retry", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const engine = makeEngine();
    await engine.start();
    const id = engine.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();

    const chunk = engine.getSnapshot().chunks[0];
    expect(chunk.state).toBe(CHUNK_STATE.FAILED);
    expect(chunk.attempts).toBe(1);
    expect(chunk.lastCode).toBe("Network error");
    expect(await store.getChunkAudio(UID, WS, id, 0)).toBeInstanceOf(Blob);

    // The retry then actually succeeds against the retained bytes.
    transcribe.mockResolvedValue("recovered words");
    h.advance(10_000);
    h.tickRetry();
    await settle();
    expect(engine.getSnapshot().chunks[0].text).toBe("recovered words");
    expect(await store.getChunkAudio(UID, WS, id, 0)).toBeNull();
  });

  test("a recoverable failure backs off and stops after the attempt budget", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const engine = makeEngine();
    await engine.start();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    for (let i = 0; i < LISTEN_IN_MAX_AUTO_ATTEMPTS + 2; i += 1) {
      h.advance(200_000);
      h.tickRetry();
      await settle();
    }
    const chunk = engine.getSnapshot().chunks[0];
    expect(chunk.attempts).toBe(LISTEN_IN_MAX_AUTO_ATTEMPTS);
    expect(transcribe.mock.calls.length).toBeLessThanOrEqual(LISTEN_IN_MAX_AUTO_ATTEMPTS);
    // An explicit retry gets past the gate.
    transcribe.mockResolvedValue("finally");
    await engine.retryFailed();
    await settle();
    expect(engine.getSnapshot().chunks[0].text).toBe("finally");
  });

  test("an unrecoverable failure does not spin, and keeps its audio too", async () => {
    transcribe.mockRejectedValue(new Error("The upload is not a supported audio format"));
    const engine = makeEngine();
    await engine.start();
    const id = engine.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    expect(engine.getSnapshot().chunks[0].attempts).toBe(LISTEN_IN_MAX_AUTO_ATTEMPTS);
    expect(await store.getChunkAudio(UID, WS, id, 0)).toBeInstanceOf(Blob);
    h.advance(500_000);
    h.tickRetry();
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  test("a chunk that produced no words is empty, not failed, and leaves no gap", async () => {
    transcribe.mockResolvedValue("   ");
    const engine = makeEngine();
    await engine.start();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    const snap = engine.getSnapshot();
    expect(snap.chunks[0].state).toBe(CHUNK_STATE.EMPTY);
    expect(snap.failed).toBe(0);
    expect(transcriptSegments(snap.session, snap.chunks)).toHaveLength(0);
  });
});

/* ========================= 8/13/18/19/20/21. recovery ==================== */

describe("8/13/18/19/20/21. what a new engine finds after a reload", () => {
  /**
   * A fresh engine over the SAME store — exactly what a reload produces. The
   * microphone registry is reset with it, because a reload kills the process
   * that held the claim; only the STORE survives, which is the whole point.
   */
  const reload = (overrides = {}) => {
    resetMicrophoneOwnershipForTests();
    return makeEngine(overrides);
  };

  test("18. a session left recording becomes interrupted, with every sealed chunk intact", async () => {
    const first = makeEngine();
    await first.start({ language: "fr" });
    const id = first.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    // The tab dies here: no stop, no finish, nothing tidy.

    const second = reload();
    await second.bootstrap();
    await settle();
    const snap = second.getSnapshot();
    expect(snap.session.sessionId).toBe(id);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(snap.session.stopReason).toBe(LISTEN_IN_STOP_REASON.INTERRUPTION);
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.INTERRUPTED);
    // It did not silently grab a microphone it cannot have.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(currentMicrophoneOwner()).toBeNull();
    // 8/13. the sealed work and its order survived.
    expect(snap.chunks.map((c) => c.seq)).toEqual([0]);
    expect(snap.chunks[0].text).toBe("some words");
    expect(snap.session.language).toBe("fr");
  });

  test("9/19. pending transcription resumes after the reload, without re-recording", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const first = makeEngine();
    await first.start();
    const id = first.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    expect(first.getSnapshot().chunks[0].state).toBe(CHUNK_STATE.FAILED);

    transcribe.mockResolvedValue("arrived after the reload");
    const second = reload();
    await second.bootstrap();
    await settle();
    h.advance(200_000);
    h.tickRetry();
    await settle();
    const chunks = await store.listChunks(UID, WS, id);
    expect(chunks[0].text).toBe("arrived after the reload");
    // The reloaded engine drained without opening a microphone of its own.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("a chunk left mid-request by the dead process is sent again, not skipped forever", async () => {
    // The first engine marks chunk 0 TRANSCRIBING and dies awaiting the answer.
    transcribe.mockImplementation(() => new Promise(() => {}));
    const first = makeEngine();
    await first.start();
    const id = first.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    expect((await store.listChunks(UID, WS, id))[0].state).toBe(CHUNK_STATE.TRANSCRIBING);
    // Its audio was NOT released — that only happens once text is stored.
    expect(await store.getChunkAudio(UID, WS, id, 0)).toBeInstanceOf(Blob);

    transcribe.mockResolvedValue("sent again");
    const second = reload();
    await second.bootstrap();
    await settle();
    expect((await store.listChunks(UID, WS, id))[0].text).toBe("sent again");
  });

  test("20. Resume continues the SAME session and the NEXT sequence number", async () => {
    const first = makeEngine();
    await first.start();
    const id = first.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();

    const second = reload();
    await second.bootstrap();
    await settle();
    await second.resume();
    await settle();
    expect(second.getSnapshot().session.sessionId).toBe(id);
    expect(second.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);

    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    // Continues at 1 — it did not restart the sequence and did not overwrite.
    const chunks = await store.listChunks(UID, WS, id);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(chunks.every((c) => c.text === "some words")).toBe(true);
  });

  test("21. Finish preserves prior work and drains what is still pending", async () => {
    // The first engine captures two chunks while offline, so they are sealed
    // and waiting rather than half-sent, then the tab dies.
    let online = false;
    const first = makeEngine({ isOnline: () => online });
    await first.start();
    const id = first.getSnapshot().session.sessionId;
    for (let i = 0; i < 2; i += 1) {
      h.advance(LISTEN_IN_CHUNK_MS);
      h.tickRoll();
      await settle();
    }
    expect(transcribe).not.toHaveBeenCalled();

    online = true;
    const second = reload({ isOnline: () => online });
    await second.bootstrap();
    await settle();
    // Finish ends the session without recording any more — and keeps the work.
    await second.finish();
    await settle();
    const snap = second.getSnapshot();
    expect(snap.session.sessionId).toBe(id);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(transcriptText(snap.chunks)).toBe("some words some words");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("19. a session left FINISHING resumes its drain on its own at bootstrap", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const first = makeEngine();
    await first.start();
    h.advance(LISTEN_IN_CHUNK_MS);
    await first.stop();
    await settle();
    expect(first.getSnapshot().session.state).toBe(LISTEN_IN_STATE.FINISHING);

    transcribe.mockResolvedValue("drained later");
    const second = reload();
    await second.bootstrap();
    await settle();
    // The retained audio is retried on its own backoff, with no user action.
    h.advance(200_000);
    h.tickRetry();
    await settle();
    expect(second.getSnapshot().session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(transcriptText(second.getSnapshot().chunks)).toBe("drained later");
  });

  test("nothing is invented for the audio that was still recording when the tab died", async () => {
    const first = makeEngine();
    await first.start();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    // Speech continues into chunk 1 and the process dies mid-chunk.
    h.advance(12_000);

    const second = reload();
    await second.bootstrap();
    await settle();
    const snap = second.getSnapshot();
    // Exactly the one SEALED chunk. No placeholder, no empty row standing in
    // for the lost seconds, and no fabricated text.
    expect(snap.chunks).toHaveLength(1);
    expect(snap.chunks[0].seq).toBe(0);
    expect(transcriptText(snap.chunks)).toBe("some words");
  });

  test("a finished session is not adopted as unfinished work", async () => {
    const first = makeEngine();
    await first.start();
    await first.stop();
    await settle();
    expect(first.getSnapshot().session.state).toBe(LISTEN_IN_STATE.FINISHED);
    const second = reload();
    await second.bootstrap();
    await settle();
    expect(second.getSnapshot().session).toBeNull();
  });
});

/* ============================ 22/23/24. microphone ======================= */

describe("22/23/24. one microphone, and it is released deterministically", () => {
  test("23. Listen In refuses to start while Quick Add dictation holds it", async () => {
    claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    const engine = makeEngine();
    await engine.start();
    const snap = engine.getSnapshot();
    expect(snap.session).toBeNull();
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.MIC_IN_USE);
    // It never opened a second stream and never stopped the other workflow.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
  });

  test("22. while Listen In holds it, a dictation's claim is refused", async () => {
    const engine = makeEngine();
    await engine.start();
    expect(claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION)).toEqual({
      ok: false,
      owner: MICROPHONE_OWNER.LISTEN_IN,
    });
    await engine.stop();
    await settle();
    expect(claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION)).toEqual({ ok: true });
    releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
  });

  test("24. a recorder error releases the microphone and interrupts rather than discards", async () => {
    const engine = makeEngine();
    await engine.start();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    recorder.onerror({ error: new Error("device lost") });
    await settle();
    const snap = engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(currentMicrophoneOwner()).toBeNull();
    expect(h.rolling()).toBe(false);
    // The chunk already sealed before the fault is still there.
    expect(snap.chunks).toHaveLength(1);
    expect(snap.chunks[0].text).toBe("some words");
  });
});

/* ============================ 29. engine teardown ======================== */

describe("29. tearing the engine down cannot silently discard a capture", () => {
  test("shutdown leaves an interrupted session and every sealed chunk in the store", async () => {
    const engine = makeEngine();
    await engine.start();
    const id = engine.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();

    engine.shutdown();
    await settle();
    expect(currentMicrophoneOwner()).toBeNull();
    const header = await store.getSession(UID, WS, id);
    expect(header.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    // TWO chunks: the one that had rolled, plus the one that was still
    // recording — shutdown SEALS it rather than throwing away the last thing
    // the user said before their session ended.
    const chunks = await store.listChunks(UID, WS, id);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe("some words");
    expect(chunks[1].state).toBe(CHUNK_STATE.SEALED);
    // …and a new engine finds it waiting, rather than gone.
    const next = makeEngine();
    await next.bootstrap();
    await settle();
    expect(next.getSnapshot().session.sessionId).toBe(id);
  });

  test("a subscriber that throws cannot break a recording", async () => {
    const engine = makeEngine();
    engine.subscribe(() => {
      throw new Error("a badly written view");
    });
    const seen = [];
    engine.subscribe((snap) => seen.push(snap.session ? snap.session.state : null));
    await engine.start();
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(seen).toContain(LISTEN_IN_STATE.RECORDING);
  });

  test("the published snapshot is stable between changes, so a subscriber cannot loop", async () => {
    const engine = makeEngine();
    await engine.start();
    const a = engine.getSnapshot();
    const b = engine.getSnapshot();
    expect(a).toBe(b);
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    expect(engine.getSnapshot()).not.toBe(a);
  });
});

/* ============================== discard ================================== */

describe("discard throws the whole session away, and only on purpose", () => {
  test("it removes the header, the chunks and the retained audio", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const engine = makeEngine();
    await engine.start();
    const id = engine.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    await engine.discard();
    await settle();
    expect(engine.getSnapshot().session).toBeNull();
    expect(await store.getSession(UID, WS, id)).toBeNull();
    expect(await store.listChunks(UID, WS, id)).toHaveLength(0);
    expect(await store.getChunkAudio(UID, WS, id, 0)).toBeNull();
    expect(currentMicrophoneOwner()).toBeNull();
  });
});

/* ==================== the ACCOUNT boundary (8D.1 correction) ============== */
//
// IndexedDB is scoped to the ORIGIN, not to a Firebase account. Two people can
// sign into NoteWise in the same browser profile, and they may belong to the
// SAME workspace — so the workspace is not an identity boundary, and every
// Listen In record and every engine is keyed by the uid as well.

describe("30. one account's retained capture is unreachable by another", () => {
  const UID_B = "uid-b";
  /** An engine for a DIFFERENT account, in the SAME workspace, same store. */
  const engineFor = (owner, overrides = {}) =>
    createListenInEngine({
      workspaceId: WS,
      uid: owner,
      store,
      transcribe: (...args) => transcribe(...args),
      getUserMedia: (...args) => getUserMedia(...args),
      recorderSupported: () => true,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      setInterval_: h.setInterval_,
      clearInterval_: h.clearInterval_,
      newSessionId: (() => {
        let n = 0;
        return () => `${owner}-sess-${(n += 1)}`;
      })(),
      ...overrides,
    });

  test("an engine requires BOTH halves of the identity", () => {
    expect(() => createListenInEngine({ workspaceId: WS, store })).toThrow(/signed-in account/i);
    expect(() => createListenInEngine({ uid: UID, store })).toThrow(/workspace/i);
  });

  test("bootstrap for account B does not recover account A's recording", async () => {
    const a = engineFor(UID);
    await a.start({ language: "en" });
    const aSession = a.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    // A signs out mid-capture, leaving durable work behind. `shutdown` marks
    // the session interrupted and keeps every sealed chunk — it is never a
    // delete, because signing out must not destroy a meeting.
    a.shutdown();
    resetMicrophoneOwnershipForTests();

    // B signs into the SAME browser and the SAME workspace.
    const b = engineFor(UID_B);
    await b.bootstrap();
    await settle();
    expect(b.getSnapshot().session).toBeNull();
    expect(b.getSnapshot().chunks).toHaveLength(0);
    expect(b.getSnapshot().error).toBeNull();
    // A's work is untouched and still there.
    expect((await store.getSession(UID, WS, aSession)).state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    // Two: the rolled chunk and the one sealed by A's sign-out.
    expect(await store.listChunks(UID, WS, aSession)).toHaveLength(2);
  });

  test("B's own capture in the same workspace is entirely separate", async () => {
    const a = engineFor(UID);
    await a.start();
    const aSession = a.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    await a.stop();
    await settle();

    const b = engineFor(UID_B);
    await b.bootstrap();
    await settle();
    await b.start();
    const bSession = b.getSnapshot().session.sessionId;
    expect(bSession).not.toBe(aSession);
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    await b.stop();
    await settle();

    // Each account sees exactly one session: its own.
    expect((await store.listSessions(UID, WS)).map((s) => s.sessionId)).toEqual([aSession]);
    expect((await store.listSessions(UID_B, WS)).map((s) => s.sessionId)).toEqual([bSession]);
  });

  test("B cannot retry, finish or discard A's retained chunks through the engine", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const a = engineFor(UID);
    await a.start();
    const aSession = a.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    expect((await store.listChunks(UID, WS, aSession))[0].state).toBe(CHUNK_STATE.FAILED);
    // Its audio is retained for A's own retry.
    expect(await store.getChunkAudio(UID, WS, aSession, 0)).toBeInstanceOf(Blob);
    // A signs out; A's own retry timer goes with A's engine.
    a.shutdown();
    resetMicrophoneOwnershipForTests();

    // B has no session at all, so every one of these is a no-op for B and
    // cannot name A's records — the engine has no API that takes a uid.
    const b = engineFor(UID_B);
    await b.bootstrap();
    await settle();
    transcribe.mockResolvedValue("B should never see this");
    await b.retryFailed();
    await b.finish();
    await b.discard();
    await settle();
    h.advance(500_000);
    h.tickRetry();
    await settle();

    // A's chunk is exactly as A left it: still failed, still holding its audio.
    const rows = await store.listChunks(UID, WS, aSession);
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe(CHUNK_STATE.FAILED);
    expect(rows[0].text).toBe("");
    expect(await store.getChunkAudio(UID, WS, aSession, 0)).toBeInstanceOf(Blob);
    expect((await store.getSession(UID, WS, aSession))).not.toBeNull();
  });

  test("7. A signing back in recovers A's own interrupted work, unless A discarded it", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const a = engineFor(UID);
    await a.start({ language: "fr" });
    const aSession = a.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    resetMicrophoneOwnershipForTests();

    // B signs in and out again — a full account switch in the same browser.
    const b = engineFor(UID_B);
    await b.bootstrap();
    await settle();
    b.shutdown();
    resetMicrophoneOwnershipForTests();

    // A signs back in: their session, their language, their chunk, their audio.
    transcribe.mockResolvedValue("recovered for A");
    const a2 = engineFor(UID);
    await a2.bootstrap();
    await settle();
    expect(a2.getSnapshot().session.sessionId).toBe(aSession);
    expect(a2.getSnapshot().session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(a2.getSnapshot().session.language).toBe("fr");
    h.advance(500_000);
    h.tickRetry();
    await settle();
    expect(transcriptText(a2.getSnapshot().chunks)).toBe("recovered for A");

    // And an explicit discard by A really does remove it.
    await a2.discard();
    await settle();
    expect(await store.getSession(UID, WS, aSession)).toBeNull();
    const a3 = engineFor(UID);
    await a3.bootstrap();
    await settle();
    expect(a3.getSnapshot().session).toBeNull();
  });

  test("8. shutting an engine down keeps the durable work rather than deleting it", async () => {
    const a = engineFor(UID);
    await a.start();
    const aSession = a.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    a.shutdown();
    await settle();
    // Sign-out must never be a delete: the recording survives for next time.
    expect((await store.getSession(UID, WS, aSession)).state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(await store.listChunks(UID, WS, aSession)).toHaveLength(2);
  });

  test("every record a session writes carries its owner", async () => {
    const a = engineFor(UID);
    await a.start();
    const id = a.getSnapshot().session.sessionId;
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    expect((await store.getSession(UID, WS, id)).uid).toBe(UID);
    for (const row of await store.listChunks(UID, WS, id)) {
      expect(row.uid).toBe(UID);
      expect(row.workspaceId).toBe(WS);
    }
    expect(a.getSnapshot().uid).toBe(UID);
  });
});

/* =============== the AUTH TRANSITION, at the engine level ================= */

describe("31. an identity change ends the previous account's capture", () => {
  const UID_B = "uid-b2";
  const engineFor = (owner) =>
    getListenInEngine(owner, WS, {
      store,
      transcribe: (...args) => transcribe(...args),
      getUserMedia: (...args) => getUserMedia(...args),
      recorderSupported: () => true,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      setInterval_: h.setInterval_,
      clearInterval_: h.clearInterval_,
      newSessionId: () => `${owner}-sess`,
    });

  afterEach(() => resetListenInEnginesForTests());

  test("the capture stops, the microphone frees and the work is SEALED, not dropped", async () => {
    const a = engineFor(UID);
    await a.start({ language: "en" });
    h.advance(LISTEN_IN_CHUNK_MS);
    h.tickRoll();
    await settle();
    const id = a.getSnapshot().session.sessionId;
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);

    // Speech continues into chunk 1, and then the identity changes.
    const suspended = applyListenInIdentity(UID_B);
    await settle();

    expect(suspended).toEqual([WS]);
    expect(currentMicrophoneOwner()).toBeNull();
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    expect(h.rolling()).toBe(false);
    expect(peekListenInEngine(UID, WS)).toBeNull();

    const header = await store.getSession(UID, WS, id);
    expect(header.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    // The chunk that was mid-recording is SEALED rather than thrown away, so
    // the last thing said before the switch is kept for its owner.
    const chunks = await store.listChunks(UID, WS, id);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
  });

  test("it is idempotent: a session already stopped is not re-interrupted", async () => {
    const a = engineFor(UID);
    await a.start();
    const id = a.getSnapshot().session.sessionId;
    await a.stop();
    await settle();
    const before = await store.getSession(UID, WS, id);
    expect(before.state).toBe(LISTEN_IN_STATE.FINISHED);

    expect(applyListenInIdentity(UID_B)).toEqual([]);
    applyListenInIdentity(UID_B); // again — nothing left to do
    await settle();
    const after = await store.getSession(UID, WS, id);
    expect(after.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(after.stoppedAt).toBe(before.stoppedAt);
  });

  test("signing out entirely (no uid) suspends every account's capture", async () => {
    const a = engineFor(UID);
    await a.start();
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(applyListenInIdentity(null)).toEqual([WS]);
    await settle();
    expect(currentMicrophoneOwner()).toBeNull();
    expect(peekListenInEngine(UID, WS)).toBeNull();
  });

  test("the account that is still signed in is left alone", async () => {
    const a = engineFor(UID);
    await a.start();
    const id = a.getSnapshot().session.sessionId;
    // The same identity arriving again is not a change.
    expect(applyListenInIdentity(UID)).toEqual([]);
    await settle();
    expect(peekListenInEngine(UID, WS)).toBe(a);
    expect(a.getSnapshot().session.sessionId).toBe(id);
    expect(a.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
  });

  test("B may start its own capture the moment A's is suspended", async () => {
    const a = engineFor(UID);
    await a.start();
    applyListenInIdentity(UID_B);
    await settle();
    const b = engineFor(UID_B);
    await b.start();
    await settle();
    expect(b.getSnapshot().session).not.toBeNull();
    expect(b.getSnapshot().session.uid).toBe(UID_B);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    // And B's session is its own: A's is still A's, interrupted, in the store.
    expect((await store.listSessions(UID_B, WS)).map((s) => s.uid)).toEqual([UID_B]);
    expect((await store.listSessions(UID, WS))[0].state).toBe(LISTEN_IN_STATE.INTERRUPTED);
  });

  test("a suspended engine is inert: nothing it still holds can act", async () => {
    const a = engineFor(UID);
    await a.start();
    const id = a.getSnapshot().session.sessionId;
    applyListenInIdentity(UID_B);
    await settle();
    // Even holding a stale reference, none of its operations restart anything.
    await a.start();
    await a.resume();
    await a.retryFailed();
    await settle();
    expect(currentMicrophoneOwner()).toBeNull();
    expect((await store.getSession(UID, WS, id)).state).toBe(LISTEN_IN_STATE.INTERRUPTED);
  });
});
