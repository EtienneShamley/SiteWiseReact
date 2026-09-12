// src/lib/listenIn/listenInModel.test.js
//
// THE PURE LISTEN IN MODEL (Phase 8D.1): the state machine, the session clock
// that survives a closed window, the chunks-as-transcript design, and the
// wording. No React, no storage, no timers — just the rules.
import {
  CHUNK_STATE,
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
  beginLeg,
  canResume,
  captureEnded,
  createChunk,
  createSession,
  defaultSessionTitle,
  drainableChunks,
  elapsedMs,
  failedChunks,
  finishInterrupted,
  formatElapsed,
  hasTranscript,
  interrupt,
  isCapturing,
  isSessionOpen,
  listenInStatusLabel,
  markFinished,
  pauseRecording,
  pendingChunks,
  requestStop,
  resumeRecording,
  sortBySeq,
  takeSeq,
  transcriptSegments,
  transcriptText,
} from "./listenInModel";

const T0 = 1_700_000_000_000;
const session = (over = {}) => ({
  ...createSession({ sessionId: "s", uid: "u", workspaceId: "w", startedAt: T0, language: "en" }),
  ...over,
});
const chunk = (seq, over = {}) => ({
  ...createChunk({
    uid: "u",
    workspaceId: "w",
    sessionId: "s",
    seq,
    mimeType: "audio/webm",
    byteLength: 10,
    startedAt: T0 + seq * 30000,
    endedAt: T0 + (seq + 1) * 30000,
    language: "en",
  }),
  ...over,
});

describe("the state machine", () => {
  test("a new session is recording, with a clock running and no sequence spent", () => {
    const s = beginLeg(session(), { now: T0 });
    expect(s.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(s.nextSeq).toBe(0);
    expect(s.stopReason).toBeNull();
    expect(s.stoppedAt).toBeNull();
    expect(isCapturing(s)).toBe(true);
    expect(isSessionOpen(s)).toBe(true);
  });

  test("recording → stopping → finishing → finished, each step only from its predecessor", () => {
    let s = beginLeg(session(), { now: T0 });
    s = requestStop(s, { now: T0 + 1000 });
    expect(s.state).toBe(LISTEN_IN_STATE.STOPPING);
    expect(s.stopReason).toBe(LISTEN_IN_STOP_REASON.USER);
    // Still capturing: the final chunk is being sealed.
    expect(isCapturing(s)).toBe(true);
    s = captureEnded(s, { now: T0 + 2000 });
    expect(s.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(s.stoppedAt).toBe(T0 + 2000);
    expect(isCapturing(s)).toBe(false);
    s = markFinished(s, { now: T0 + 3000 });
    expect(s.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(isSessionOpen(s)).toBe(false);
    // …and no step goes backwards.
    expect(requestStop(s, { now: T0 }).state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(captureEnded(s, { now: T0 }).state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(markFinished(session(), { now: T0 }).state).toBe(LISTEN_IN_STATE.RECORDING);
  });

  test("a stop carries its reason, and `limit` is reserved but never produced here", () => {
    const s = requestStop(beginLeg(session(), { now: T0 }), {
      reason: LISTEN_IN_STOP_REASON.ERROR,
      now: T0,
    });
    expect(s.stopReason).toBe(LISTEN_IN_STOP_REASON.ERROR);
    // The constant exists for the later duration phase and is not used yet.
    expect(LISTEN_IN_STOP_REASON.LIMIT).toBe("limit");
  });

  test("an interruption is not a stop: it waits for the user rather than finishing", () => {
    const s = interrupt(beginLeg(session(), { now: T0 }), { now: T0 + 5000 });
    expect(s.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(s.stopReason).toBe(LISTEN_IN_STOP_REASON.INTERRUPTION);
    expect(canResume(s)).toBe(true);
    expect(isSessionOpen(s)).toBe(true);
    // A session whose capture was already over is not "interrupted" by a reload.
    const finishing = captureEnded(beginLeg(session(), { now: T0 }), { now: T0 });
    expect(interrupt(finishing, { now: T0 }).state).toBe(LISTEN_IN_STATE.FINISHING);
  });

  test("interrupted → recording (resume) or → finishing (finish), and nothing else", () => {
    const s = interrupt(beginLeg(session(), { now: T0 }), { now: T0 + 5000 });
    const resumed = resumeRecording(s, { now: T0 + 9000 });
    expect(resumed.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(resumed.stopReason).toBeNull();
    expect(resumed.stoppedAt).toBeNull();
    const finished = finishInterrupted(s, { now: T0 + 9000 });
    expect(finished.state).toBe(LISTEN_IN_STATE.FINISHING);
    // Neither transition applies to a session that is not interrupted.
    expect(resumeRecording(session(), { now: T0 }).state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(finishInterrupted(session(), { now: T0 }).state).toBe(LISTEN_IN_STATE.RECORDING);
  });

  test("sequence numbers are handed out by the SESSION, so a resume continues them", () => {
    let s = beginLeg(session(), { now: T0 });
    const a = takeSeq(s, { now: T0 });
    const b = takeSeq(a.session, { now: T0 });
    expect([a.seq, b.seq]).toEqual([0, 1]);
    // …across an interruption and a resume.
    s = resumeRecording(interrupt(b.session, { now: T0 }), { now: T0 });
    expect(takeSeq(s, { now: T0 }).seq).toBe(2);
  });
});

describe("the session clock", () => {
  test("elapsed is banked time plus the live leg — no view has to count", () => {
    const s = beginLeg(session(), { now: T0 });
    expect(elapsedMs(s, T0)).toBe(0);
    expect(elapsedMs(s, T0 + 45_000)).toBe(45_000);
    expect(elapsedMs(s, T0 + 7_200_000)).toBe(7_200_000);
  });

  test("time while NOT recording is not counted, and a resume adds to the total", () => {
    let s = beginLeg(session(), { now: T0 });
    s = interrupt(s, { now: T0 + 60_000 }); // one minute captured
    expect(elapsedMs(s, T0 + 600_000)).toBe(60_000); // nine idle minutes ignored
    s = resumeRecording(s, { now: T0 + 600_000 });
    expect(elapsedMs(s, T0 + 630_000)).toBe(90_000); // plus thirty more seconds
  });

  test("it is formatted for a meeting: mm:ss under an hour, h:mm:ss beyond", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(600_000)).toBe("10:00");
    expect(formatElapsed(3_599_000)).toBe("59:59");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(14_400_000)).toBe("4:00:00");
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(undefined)).toBe("0:00");
  });

  test("a session is named for when it happened", () => {
    expect(defaultSessionTitle(T0)).toMatch(/^Listen In — \d{1,2} \w{3} \d{4}, \d{2}:\d{2}$/);
  });
});

describe("the chunks ARE the transcript", () => {
  test("segments keep their own identity, timing, state and reserved speaker", () => {
    const s = session();
    const chunks = [
      chunk(0, { state: CHUNK_STATE.TRANSCRIBED, text: "first" }),
      chunk(1, { state: CHUNK_STATE.TRANSCRIBED, text: "second" }),
    ];
    const segments = transcriptSegments(s, chunks);
    expect(segments.map((x) => x.seq)).toEqual([0, 1]);
    expect(segments[0].offsetMs).toBe(0);
    expect(segments[1].offsetMs).toBe(30000);
    expect(segments.every((x) => x.speaker === null)).toBe(true);
    expect(segments.every((x) => x.language === "en")).toBe(true);
  });

  test("the joined text is DERIVED in sequence order, whatever order the rows arrive", () => {
    const chunks = [
      chunk(2, { state: CHUNK_STATE.TRANSCRIBED, text: "third" }),
      chunk(0, { state: CHUNK_STATE.TRANSCRIBED, text: "first" }),
      chunk(1, { state: CHUNK_STATE.TRANSCRIBED, text: "second" }),
    ];
    expect(transcriptText(chunks)).toBe("first second third");
    expect(hasTranscript(chunks)).toBe(true);
    expect(sortBySeq(chunks).map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  test("only transcribed text is joined — a sealed or failed chunk contributes nothing", () => {
    const chunks = [
      chunk(0, { state: CHUNK_STATE.TRANSCRIBED, text: "kept" }),
      chunk(1, { state: CHUNK_STATE.SEALED }),
      chunk(2, { state: CHUNK_STATE.FAILED, text: "" }),
    ];
    expect(transcriptText(chunks)).toBe("kept");
    // …but a FAILED chunk is still SHOWN as a segment, so a gap is visible
    // rather than silently absent.
    expect(transcriptSegments(session(), chunks).map((x) => x.state)).toEqual([
      CHUNK_STATE.TRANSCRIBED,
      CHUNK_STATE.SEALED,
      CHUNK_STATE.FAILED,
    ]);
    // An EMPTY chunk (real silence) is not a gap and is omitted.
    expect(transcriptSegments(session(), [chunk(0, { state: CHUNK_STATE.EMPTY })])).toHaveLength(0);
  });

  test("a new chunk starts sealed, with no text, no attempts and no speaker", () => {
    const c = chunk(0);
    expect(c.state).toBe(CHUNK_STATE.SEALED);
    expect(c.text).toBe("");
    expect(c.attempts).toBe(0);
    expect(c.speaker).toBeNull();
    expect(c.recovered).toBe(false);
  });
});

describe("which chunks still owe work", () => {
  const chunks = [
    chunk(0, { state: CHUNK_STATE.TRANSCRIBED, text: "done" }),
    chunk(1, { state: CHUNK_STATE.SEALED }),
    chunk(2, { state: CHUNK_STATE.TRANSCRIBING }),
    chunk(3, { state: CHUNK_STATE.FAILED, attempts: 2 }),
    chunk(4, { state: CHUNK_STATE.FAILED, attempts: 5 }),
    chunk(5, { state: CHUNK_STATE.EMPTY }),
  ];

  test("pending is what the user is waiting on; failed is what needs attention", () => {
    expect(pendingChunks(chunks).map((c) => c.seq)).toEqual([1, 2]);
    expect(failedChunks(chunks).map((c) => c.seq)).toEqual([3, 4]);
  });

  test("the drain also revisits a failure that still has attempts, but not one that does not", () => {
    expect(drainableChunks(chunks, { maxAttempts: 5 }).map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(drainableChunks(chunks, { maxAttempts: 2 }).map((c) => c.seq)).toEqual([1, 2]);
  });
});

describe("the one status sentence", () => {
  test("it says what is happening in words, never by colour alone", () => {
    const rec = beginLeg(session(), { now: T0 });
    expect(listenInStatusLabel(rec, [])).toBe("Recording…");
    expect(listenInStatusLabel(rec, [chunk(0)])).toBe("Recording… transcribing earlier speech");
    // 8D.3.1: the user-facing words are "Completing meeting…" / "Completed"
    // for the stored `stopping` / `finishing` / `finished` states.
    expect(listenInStatusLabel(requestStop(rec, { now: T0 }), [])).toBe("Completing meeting…");
    const fin = captureEnded(rec, { now: T0 });
    expect(listenInStatusLabel(fin, [chunk(0)])).toBe("Completing meeting — 1 part still transcribing…");
    expect(listenInStatusLabel(fin, [chunk(0), chunk(1)])).toBe("Completing meeting — 2 parts still transcribing…");
    expect(listenInStatusLabel(interrupt(rec, { now: T0 }), [])).toBe("Interrupted — resume or complete the meeting.");
    // 8D.3.1 wording: the user STOPPED RECORDING. "Stopped", never "Paused" —
    // that is the internal state name — and never presented as a failure.
    const stoppedLeg = pauseRecording(rec, { now: T0 + 5000 });
    expect(stoppedLeg.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(listenInStatusLabel(stoppedLeg, [])).toBe(
      "Stopped — start recording again, or complete the meeting."
    );
    expect(listenInStatusLabel(stoppedLeg, [chunk(0)])).toBe(
      "Stopped — transcribing earlier speech. Start recording again, or complete the meeting."
    );
    for (const state of Object.values(LISTEN_IN_STATE)) {
      const label = listenInStatusLabel({ ...rec, state }, []);
      expect(label).not.toMatch(/Paused|paused/);
    }
  });

  test("a finished session is honest about silence and about failures", () => {
    const done = markFinished(captureEnded(beginLeg(session(), { now: T0 }), { now: T0 }), { now: T0 });
    expect(listenInStatusLabel(done, [chunk(0, { state: CHUNK_STATE.TRANSCRIBED, text: "hi" })])).toBe(
      "Completed."
    );
    expect(listenInStatusLabel(done, [chunk(0, { state: CHUNK_STATE.EMPTY })])).toBe(
      "Completed — no speech was detected."
    );
    expect(listenInStatusLabel(done, [chunk(0, { state: CHUNK_STATE.FAILED })])).toBe(
      "Completed, with 1 part not transcribed."
    );
  });
});
