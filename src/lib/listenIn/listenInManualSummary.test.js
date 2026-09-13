// src/lib/listenIn/listenInManualSummary.test.js
//
// EXPLICIT SUMMARISE, SHORT MEETINGS, AND CLEAR (2026-09-13 correction after
// the first real runtime test of Phase 8D.4).
//
// The real engine with the microphone, recorder, clock, timers, transcription
// and summariser injected — and, for the Clear cases, the real 8D.4 cloud
// bridge, outbox and memory workspace store, so "Clear deletes nothing, locally
// or in the account" is observed rather than asserted from source.
//
//   MANUAL SUMMARISE   uses the same engine pipeline and the same summariser
//                      as the automatic loop; ignores the progressive gates;
//                      consolidates; never reopens the microphone; never
//                      changes the meeting id; replaces the summary revision
//                      and syncs it as a newer cloud revision.
//   SHORT MEETING      a ~40-second meeting with real speech is summarised on
//                      Complete, and by hand before Complete.
//   FAILURE            a failed summary leaves the Original intact; Try
//                      summarising again is the same control and the same
//                      meeting.
//   CLEAR              resets the engine's view of a COMPLETED meeting; keeps
//                      the local rows, the summary, the bookkeeping and the
//                      Firestore documents; queues no delete; the next Start is
//                      a new id; bootstrap never re-adopts the cleared meeting.
//   404                a backend without the route is UNAVAILABLE, not a
//                      generic failure — the real cause found on 2026-09-13.
import "fake-indexeddb/auto";
import { installStructuredCloneShim } from "../assetDbTestHarness";
import { __resetDurableStorageForTests } from "../durableStorage";
import { __resetNoteTombstonesForTests } from "../noteTombstones";
import { __resetCloudCaptureForTests, installCloudCapture } from "../cloud/cloudCapture";
import { CLOUD_COLLECTION } from "../cloud/cloudModel";
import { OUTBOX_OP, clearOutbox, listOutboxEntries, outboxSize } from "../cloud/cloudOutbox";
import { createCloudSync } from "../cloud/cloudSync";
import { createMemoryWorkspaceStore } from "../cloud/memoryWorkspaceStore";
import { transcriptPageDocumentId } from "../cloud/listenInCloudModel";
import { installListenInCloudSync } from "./listenInCloudSync";
import { createListenInEngine, getListenInEngine, resetListenInEnginesForTests } from "./listenInEngine";
import { CHUNK_STATE, LISTEN_IN_STATE, transcriptText } from "./listenInModel";
import { LISTEN_IN_SUMMARY_POLICY, LISTEN_IN_SUMMARY_STATUS } from "./listenInSummaryModel";
import { createListenInMemoryStore } from "./listenInStore";
import { requestListenInSummary } from "./listenInSummaryClient";
import { LISTEN_IN_SUMMARY_OUTCOME } from "../listenInSummaryContract";
import { MICROPHONE_OWNER, currentMicrophoneOwner, resetMicrophoneOwnershipForTests } from "../microphoneOwnership";

installStructuredCloneShim();

const UID = "alice";
const WS = "ws-manual";
const MEETINGS = CLOUD_COLLECTION.LISTEN_IN_MEETINGS;
const TRANSCRIPTS = CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS;
const SUMMARIES = CLOUD_COLLECTION.LISTEN_IN_SUMMARIES;

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  constructor(stream, options) {
    this.mimeType = (options && options.mimeType) || "audio/webm";
    this.state = "inactive";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(32)], { type: this.mimeType }) });
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
  minted = 0;
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  installCloudCapture({ storage: localStorage });
});
afterEach(() => {
  resetListenInEnginesForTests();
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
  clearOutbox(WS, localStorage);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** SHORT speech — one 30-second chunk of it is far under the 2 500-character gate. */
const SHORT = "Testing, testing. We walked the eastern fence and the posts by the creek are rotten. Sam will order timber by Friday.";

const result = (text) => ({ summaryText: text, keyPoints: ["Posts are rotten"], decisions: ["Replace six posts"], actionItems: [{ task: "Order timber", owner: "Sam", dueDate: "Friday", sourceSeq: 0 }], risks: [], followUps: [] });

let minted = 0; // reset per test, so every test's first meeting is "meeting-1"

/** An engine (through the registry, over the 8D.4 bridge when `cloud` is given). */
function rig({ transcribe, summarise, cloud = null, listenInStore = createListenInMemoryStore() } = {}) {
  let clock = 1_700_000_000_000;
  let roll = null;
  const timers = new Map();
  let nextTimerId = 1;
  const tracks = [{ stop: jest.fn() }];
  const getUserMedia = jest.fn(async () => ({ getTracks: () => tracks }));
  const summariser = summarise || jest.fn(async (request) => ({ ok: true, result: result(request.mode === "window" ? `window ${request.segments[0].seq}` : "final account") }));
  const bridge = cloud
    ? installListenInCloudSync({ uid: UID, workspaceId: WS, approved: true, store: listenInStore, storage: localStorage, now: () => clock })
    : null;
  const sync = cloud
    ? createCloudSync({ workspaceId: WS, store: cloud, storage: localStorage, payloadProviders: bridge.providers, isOnline: () => true, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {}, now: () => clock }).start()
    : null;
  const engine = getListenInEngine(UID, WS, {
    store: cloud ? undefined : listenInStore,
    transcribe: transcribe || (async () => SHORT),
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
    isOnline: () => true,
    addOnlineListener: () => () => {},
    addWakeListener: () => () => {},
    newSessionId: () => `meeting-${(minted += 1)}`,
  });
  return {
    engine,
    summarise: summariser,
    getUserMedia,
    tracks,
    listenInStore,
    cloud,
    sync,
    bridge,
    roll: () => roll && roll(),
    advance: (ms) => {
      clock += ms;
    },
    fireTimers: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    /** Transcription only. Nothing summarises on its own (2026-09-13). */
    async drain() {
      await settle();
      await engine.flush();
      await settle();
    },
    /** The user presses Summarise, and the request runs to completion. */
    async requestSummary(options) {
      await engine.summariseNow(options);
      await settle();
      await engine.flushSummary();
      await settle();
    },
    async flushCloud() {
      if (!bridge) return;
      await bridge.store.idle();
      await sync.flush();
      await settle();
    },
    stop() {
      if (sync) sync.stop();
      if (bridge) bridge.uninstall();
    },
  };
}

async function begin(r) {
  await r.engine.bootstrap();
  await settle();
  await r.engine.start({ language: "en" });
  await settle();
}
async function speak(r, seconds = 30) {
  r.advance(seconds * 1000);
  r.roll();
  await settle();
}
const snap = (r) => r.engine.getSnapshot();
const windowCalls = (r) => r.summarise.mock.calls.filter(([req]) => req.mode === "window");
const finalCalls = (r) => r.summarise.mock.calls.filter(([req]) => req.mode === "final");

/* ===================== 13–16. a short meeting is summarisable ============ */

describe("a ~40-second meeting is summarisable", () => {
  test("6/13/14. a transcribed chunk triggers nothing; an explicit Summarise reads it at once, however short", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    await r.drain();
    // Transcribed, and far below the old progressive threshold: nothing spent.
    expect(transcriptText(snap(r).chunks)).toBe(SHORT);
    expect(SHORT.length).toBeLessThan(LISTEN_IN_SUMMARY_POLICY.minWindowChars);
    expect(r.summarise).not.toHaveBeenCalled();
    expect(snap(r).summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.IDLE);

    await r.requestSummary();
    expect(windowCalls(r)).toHaveLength(1);
    expect(windowCalls(r)[0][0].segments.map((s) => s.text)).toEqual([SHORT]);
    // ...and consolidated, so the Summarised view is one account so far.
    expect(finalCalls(r)).toHaveLength(1);
    const summary = snap(r).summary;
    expect(summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.READY);
    expect(summary.result.summaryText).toBe("final account");
    expect(summary.revision).toBeGreaterThanOrEqual(2);
    // The meeting itself is untouched: still recording, same id, mic held.
    expect(snap(r).session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap(r).session.sessionId).toBe("meeting-1");
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(r.getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("9/10/20/21. Complete meeting summarises NOTHING; a completed meeting validly has a transcript and no summary, and still offers Summarise", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    r.advance(10000);
    await r.engine.complete(); // seals the 10-second chunk in progress
    await r.drain();
    await r.drain();
    let s = snap(r);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(s.session.capturedMs).toBe(40000);
    expect(transcriptText(s.chunks)).toBe(`${SHORT} ${SHORT}`);
    // No request of any kind, and no summary record was ever written.
    expect(r.summarise).not.toHaveBeenCalled();
    expect(s.summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.IDLE);
    expect(s.summary.revision).toBe(0);
    expect(await r.listenInStore.getSummary(UID, WS, "meeting-1")).toBeNull();
    expect(s.summaryCoverage.complete).toBe(false);

    // The user asks after completion: same meeting, no microphone, one pass.
    await r.requestSummary();
    s = snap(r);
    expect(windowCalls(r)).toHaveLength(1);
    expect(finalCalls(r)).toHaveLength(1);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(s.session.sessionId).toBe("meeting-1");
    expect(s.summary.final).toBe(true);
    expect(s.summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.READY);
    expect(s.summaryCoverage.complete).toBe(true);
    expect(r.getUserMedia).toHaveBeenCalledTimes(1);
    // Persisted: a fresh read of the store carries the summary.
    const stored = await r.listenInStore.getSummary(UID, WS, "meeting-1");
    expect(stored.final).toBe(true);
    expect(stored.result.summaryText).toBe("final account");
  });

  test("7/8. Stop recording and Start recording again trigger nothing", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    await r.engine.pause();
    await r.drain();
    expect(r.summarise).not.toHaveBeenCalled();
    await r.engine.resume();
    await settle();
    await speak(r, 30);
    await r.drain();
    expect(r.summarise).not.toHaveBeenCalled();
    expect(snap(r).summary.revision).toBe(0);
    expect(await r.listenInStore.getSummary(UID, WS, "meeting-1")).toBeNull();
  });

  test("Stop → Start recording keeps ONE continuous Original transcript, and Summarise reads both legs", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    await r.engine.pause();
    await settle();
    await r.engine.resume();
    await settle();
    await speak(r, 30);
    await r.drain();
    const chunks = snap(r).chunks;
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(snap(r).session.sessionId).toBe("meeting-1");
    await r.requestSummary();
    expect(windowCalls(r)[0][0].segments.map((s) => s.seq)).toEqual([0, 1, 2]);
  });
});

/* ====================== 6–12. manual summarise behaviour ================= */

describe("explicit Summarise", () => {
  test("7/8. it is the existing summary pipeline — the same summariser, window then final — and nothing else", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    await r.drain();
    await r.requestSummary();
    expect(r.summarise.mock.calls.map(([req]) => req.mode)).toEqual(["window", "final"]);
    for (const [req] of r.summarise.mock.calls) {
      expect(Object.keys(req).sort()).toEqual(req.mode === "window" ? ["mode", "segments"] : ["mode", "parts"]);
    }
  });

  test("9. Summarise again after a summary produces a NEWER summary revision, same meeting, same Original", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    await r.engine.pause();
    await r.drain();
    await r.requestSummary();
    const first = snap(r).summary;
    const original = transcriptText(snap(r).chunks);
    await r.requestSummary();
    const second = snap(r).summary;
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(snap(r).session.sessionId).toBe("meeting-1");
    expect(transcriptText(snap(r).chunks)).toBe(original);
    expect(snap(r).chunks).toHaveLength(2);
    expect(currentMicrophoneOwner()).toBeNull();
    expect(r.getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("16. Summarise again after more recording includes the NEWER transcript, same meeting", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    await r.engine.pause();
    await r.drain();
    await r.requestSummary();
    expect(windowCalls(r)).toHaveLength(1);
    expect(windowCalls(r)[0][0].segments.map((s) => s.seq)).toEqual([0, 1]);
    // Start recording again, add transcript, stop, summarise again.
    await r.engine.resume();
    await settle();
    await speak(r, 30);
    await r.engine.pause();
    await r.drain();
    expect(snap(r).chunks).toHaveLength(4);
    expect(r.summarise.mock.calls.length).toBe(2); // window + final from the first request only
    await r.requestSummary();
    // The second request read only what was new, then consolidated everything.
    expect(windowCalls(r)).toHaveLength(2);
    expect(windowCalls(r)[1][0].segments.map((s) => s.seq)).toEqual([2, 3]);
    expect(finalCalls(r)).toHaveLength(2);
    expect(snap(r).summary.coveredThroughSeq).toBe(3);
    expect(snap(r).session.sessionId).toBe("meeting-1");
  });

  test("10/11/12/17. a failed summary leaves the Original intact; Try summarising again is the same meeting with no microphone", async () => {
    let fail = true;
    const summarise = jest.fn(async (request) => (fail ? { ok: false, outcome: "failure", message: "The summary could not be generated." } : { ok: true, result: result(request.mode === "window" ? "window" : "final account") }));
    const r = rig({ summarise });
    await begin(r);
    await speak(r, 30);
    r.advance(10000);
    await r.engine.complete();
    await r.drain();
    await r.drain();
    expect(summarise).not.toHaveBeenCalled();
    // The user asks; the request fails.
    await r.requestSummary();
    let s = snap(r);
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(s.summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.FAILED);
    expect(s.summary.lastErrorOutcome).toBe("failure");
    expect(transcriptText(s.chunks)).toBe(`${SHORT} ${SHORT}`);
    expect(await r.listenInStore.listChunks(UID, WS, "meeting-1")).toHaveLength(2);
    // No automatic retry follows a failed request.
    await r.drain();
    await r.drain();
    expect(summarise).toHaveBeenCalledTimes(1);

    fail = false;
    await r.requestSummary();
    s = snap(r);
    expect(s.summary.status).toBe(LISTEN_IN_SUMMARY_STATUS.READY);
    expect(s.summary.lastErrorOutcome).toBeNull();
    expect(s.summary.final).toBe(true);
    expect(s.session.sessionId).toBe("meeting-1");
    expect(s.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(r.getUserMedia).toHaveBeenCalledTimes(1);
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("it refuses on a stopped engine and does nothing for a meeting with no transcript", async () => {
    const r = rig();
    await begin(r);
    await r.requestSummary();
    expect(r.summarise).not.toHaveBeenCalled();
    r.engine.shutdown();
    await r.engine.summariseNow();
    expect(r.summarise).not.toHaveBeenCalled();
  });
});

/* ============================ 18–26. CLEAR ============================== */

describe("Clear: a completed meeting leaves the window, and nothing is deleted", () => {
  function workspaceStore() {
    const store = createMemoryWorkspaceStore();
    store.setUser(UID);
    store.seed(["workspaces", WS], { id: WS, ownerUid: UID });
    store.seed(["workspaces", WS, "members", UID], { uid: UID, role: "owner" });
    return store;
  }

  async function completedAndSynced() {
    const cloud = workspaceStore();
    const listenInStore = createListenInMemoryStore();
    const r = rig({ cloud, listenInStore });
    await begin(r);
    await speak(r, 30);
    await r.engine.complete();
    await r.drain();
    await r.drain();
    await r.requestSummary(); // the user asked for a summary before clearing
    await r.flushCloud();
    await r.flushCloud();
    expect(outboxSize(WS, localStorage)).toBe(0);
    return r;
  }

  test("19/20/21/22/23/24. Clear resets the view and keeps the local rows, the summary, the bookkeeping and the cloud documents; no delete is queued", async () => {
    const r = await completedAndSynced();
    const id = snap(r).session.sessionId;
    expect(snap(r).session.state).toBe(LISTEN_IN_STATE.FINISHED);
    const before = {
      session: await r.listenInStore.getSession(UID, WS, id),
      chunks: await r.listenInStore.listChunks(UID, WS, id),
      summary: await r.listenInStore.getSummary(UID, WS, id),
      states: await r.listenInStore.listSyncStates(UID, WS, id),
      cloud: JSON.stringify(r.cloud.dump()),
    };
    expect(before.chunks).toHaveLength(2);
    expect(r.cloud.get(["workspaces", WS, MEETINGS, id])).toBeTruthy();

    await r.engine.clear();
    await settle();
    // The view is empty and ready.
    const s = snap(r);
    expect(s.session).toBeNull();
    expect(s.chunks).toEqual([]);
    expect(s.summary).toBeNull();
    expect(s.active).toBe(false);
    expect(s.error).toBeNull();
    // Nothing was deleted, locally…
    expect(await r.listenInStore.getSession(UID, WS, id)).toEqual(before.session);
    expect(await r.listenInStore.listChunks(UID, WS, id)).toEqual(before.chunks);
    expect(await r.listenInStore.getSummary(UID, WS, id)).toEqual(before.summary);
    expect(await r.listenInStore.listSyncStates(UID, WS, id)).toEqual(before.states);
    // …and nothing was queued for the account, so nothing changes there either.
    expect(outboxSize(WS, localStorage)).toBe(0);
    expect(listOutboxEntries(WS, localStorage).filter((e) => e.op === OUTBOX_OP.DELETE)).toEqual([]);
    await r.flushCloud();
    expect(JSON.stringify(r.cloud.dump())).toBe(before.cloud);
    expect(r.cloud.get(["workspaces", WS, MEETINGS, id])).toMatchObject({ state: LISTEN_IN_STATE.FINISHED });
    expect(r.cloud.get(["workspaces", WS, TRANSCRIPTS, transcriptPageDocumentId(id, 0)])).toBeTruthy();
    expect(r.cloud.get(["workspaces", WS, SUMMARIES, id])).toBeTruthy();
    r.stop();
  });

  test("25/26. after Clear the next Start is a NEW meeting, and a fresh engine never re-adopts the cleared one", async () => {
    const r = await completedAndSynced();
    const first = snap(r).session.sessionId;
    await r.engine.clear();
    await r.engine.start({ language: "en" });
    await settle();
    const second = snap(r).session.sessionId;
    expect(second).not.toBe(first);
    expect(snap(r).session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap(r).chunks).toEqual([]);
    expect(snap(r).summary.revision).toBe(0);
    await r.engine.complete();
    await r.drain();
    await r.drain();
    await r.flushCloud();
    // The second meeting was never summarised: it syncs with NO summary document.
    expect(r.cloud.get(["workspaces", WS, SUMMARIES, second])).toBeNull();
    expect(r.cloud.get(["workspaces", WS, MEETINGS, second])).toMatchObject({ state: LISTEN_IN_STATE.FINISHED, summaryRevision: 0 });
    // Both meetings are records now, in the store and in the account.
    expect((await r.listenInStore.listSessions(UID, WS)).map((x) => x.sessionId).sort()).toEqual([first, second].sort());
    expect(Object.keys(r.cloud.listWorkspaceDocs(WS, MEETINGS)).sort()).toEqual([first, second].sort());
    r.stop();
    resetListenInEnginesForTests();
    const again = createListenInEngine({ uid: UID, workspaceId: WS, store: r.listenInStore, recorderSupported: () => true, setTimer: () => 0, clearTimer: () => {}, setInterval_: () => 1, clearInterval_: () => {}, addWakeListener: () => () => {}, addOnlineListener: () => () => {} });
    await again.bootstrap();
    expect(again.getSnapshot().session).toBeNull();
    expect(again.getSnapshot().active).toBe(false);
    again.shutdown();
  });

  test("27/28. Clear is refused for an UNFINISHED meeting — recording, stopped, interrupted — and Discard still deletes one", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 30);
    await r.engine.clear();
    expect(snap(r).session).not.toBeNull();
    expect(snap(r).session.state).toBe(LISTEN_IN_STATE.RECORDING);
    await r.engine.pause();
    await r.engine.clear();
    expect(snap(r).session.state).toBe(LISTEN_IN_STATE.PAUSED);
    const id = snap(r).session.sessionId;
    // Discard is unchanged: the destructive end of an unfinished meeting.
    await r.engine.discard();
    await settle();
    expect(snap(r).session).toBeNull();
    expect(await r.listenInStore.getSession(UID, WS, id)).toBeNull();
    expect(await r.listenInStore.listChunks(UID, WS, id)).toEqual([]);
  });
});

/* ============================ the real cause ============================= */

describe("a backend that does not have the route", () => {
  test("404 is reported as UNAVAILABLE — retrying the same request cannot help — and never as a generic failure", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "Not found", code: "not_found" }) }));
    const out = await requestListenInSummary({ mode: "window", segments: [{ seq: 0, text: SHORT }], fetchImpl, getToken: async () => "token" });
    expect(out.ok).toBe(false);
    expect(out.outcome).toBe(LISTEN_IN_SUMMARY_OUTCOME.UNAVAILABLE);
    expect(out.message).toMatch(/currently unavailable/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toMatch(/\/api\/listen-in\/summary$/);
    expect(url).not.toMatch(/refine/);
  });
});
