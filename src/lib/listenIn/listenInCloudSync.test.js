// src/lib/listenIn/listenInCloudSync.test.js
//
// LISTEN IN TEXT RESULTS IN THE ACCOUNT (Phase 8D.4), proved as behaviour:
// the REAL engine (microphone, recorder, clock, timers, transcription and
// summariser injected) over the REAL bridge, the REAL outbox and capture,
// the REAL sync engine and the in-memory workspace store that enforces what
// the Security Rules enforce.
//
//   CLOUD DATA     header, ordered transcript, summary, four-hour paging,
//                  coverage/failure state
//   AUDIO          no Blob in any payload, no Storage upload, no asset queue
//                  entry, failed audio stays local
//   LOCAL-FIRST    a Firestore outage stops nothing; completion is local;
//                  offline work queues, reconnect flushes, reload resumes
//   CONFLICTS      idempotent replays; stale writes refused; newer summary
//                  revisions win; Stop/Start cycles mint no new meeting
//   CROSS DEVICE   another member hydrates metadata, transcript, summary and
//                  coverage — and is offered no retry it cannot perform
//   IDENTITY       createdBy preserved; completed ≠ active; stopped and
//                  interrupted meetings stay active locally; hydration mints
//                  no active meeting
//   SESSION        the bridge is installed only when approved, and the engine
//                  the view layer creates is handed its store
import "fake-indexeddb/auto";
import { installStructuredCloneShim } from "../assetDbTestHarness";
import { __resetDurableStorageForTests } from "../durableStorage";
import { __resetNoteTombstonesForTests } from "../noteTombstones";
import { __resetCloudCaptureForTests, captureExternalChanges, installCloudCapture } from "../cloud/cloudCapture";
import { CLOUD_COLLECTION } from "../cloud/cloudModel";
import { OUTBOX_OP, clearOutbox, listOutboxEntries, outboxSize } from "../cloud/cloudOutbox";
import { SYNC_OUTCOME, SYNC_STATUS, createCloudSync } from "../cloud/cloudSync";
import { createMemoryWorkspaceStore } from "../cloud/memoryWorkspaceStore";
import { openWorkspaceSession } from "../cloud/workspaceSession";
import {
  SIGNATURE_VERSION,
  assertNoBinaryInPayload,
  findBinaryInPayload,
  transcriptPageDocumentId,
} from "../cloud/listenInCloudModel";
import { countPendingAssetUploads } from "../assetUploadQueue";
import {
  LISTEN_IN_BINARY_PAYLOAD_CODE,
  RETRY_UNAVAILABLE_REASON,
  createListenInPayloadProviders,
  installListenInCloudSync,
  listCloudListenInMeetings,
  listenInRetryAvailability,
  loadCloudListenInMeeting,
  reconcileListenInOutbox,
  withListenInCloudCapture,
} from "./listenInCloudSync";
import {
  createListenInEngine,
  getListenInEngine,
  registeredListenInStore,
  resetListenInEnginesForTests,
} from "./listenInEngine";
import { CHUNK_STATE, LISTEN_IN_STATE, createChunk, createSession, transcriptText } from "./listenInModel";
import { LISTEN_IN_CLOUD_TEXT_SYNC_APPROVED, LISTEN_IN_PERSISTENCE } from "./listenInPolicy";
import { LISTEN_IN_SUMMARY_POLICY } from "./listenInSummaryModel";
import { createListenInMemoryStore } from "./listenInStore";
import { MICROPHONE_OWNER, currentMicrophoneOwner, resetMicrophoneOwnershipForTests } from "../microphoneOwnership";

installStructuredCloneShim();

const UID = "alice";
const OTHER = "bob";
const WS = "ws-listen-cloud";
const MEETINGS = CLOUD_COLLECTION.LISTEN_IN_MEETINGS;
const TRANSCRIPTS = CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS;
const SUMMARIES = CLOUD_COLLECTION.LISTEN_IN_SUMMARIES;

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
  localStorage.clear();
  __resetDurableStorageForTests();
  __resetNoteTombstonesForTests();
  __resetCloudCaptureForTests();
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  FakeMediaRecorder.instances = [];
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

const summaryResult = (text) => ({
  summaryText: text,
  keyPoints: ["Boundary walked"],
  decisions: ["Drainage agreed"],
  actionItems: [{ task: "Order pipes", owner: "Sam", dueDate: null, sourceSeq: 0 }],
  risks: [],
  followUps: [],
});

/** Long enough that one chunk clears the summary policy's size gate. */
const WORDS = "The team walked the eastern boundary and agreed the drainage plan. ".repeat(60).trim();

/* ------------------------------- the rig --------------------------------- */

// Session ids are minted from ONE counter across every rig in this file, so a
// second engine over the same store or the same cloud is visibly a new
// meeting — never a colliding id.
let minted = 0;
beforeEach(() => {
  minted = 0;
});

function workspaceStore() {
  const store = createMemoryWorkspaceStore();
  store.setUser(UID);
  store.seed(["workspaces", WS], { id: WS, ownerUid: UID });
  store.seed(["workspaces", WS, "members", UID], { uid: UID, role: "owner" });
  store.seed(["workspaces", WS, "members", OTHER], { uid: OTHER, role: "member" });
  store.seed(["workspaces", WS, "members", "mia"], { uid: "mia", role: "member" });
  return store;
}

/**
 * Everything under the test's control: the workspace store (the cloud), the
 * Listen In store (this device's IndexedDB, in memory and SHARED across
 * engines so a "reload" is a new engine over the same rows), the bridge, the
 * sync engine and the real engine created THROUGH THE REGISTRY, so the store
 * the bridge registered is the one the engine writes to.
 */
function rig({ transcribe, summarise, online = true, listenInStore = createListenInMemoryStore(), cloud = workspaceStore(), approved = true, uid = UID } = {}) {
  let clock = 1_700_000_000_000;
  let roll = null;
  const timers = new Map();
  let nextTimerId = 1;
  let isOnlineValue = online;
  let onlineListener = null;
  const tracks = [{ stop: jest.fn() }];
  const getUserMedia = jest.fn(async () => ({ getTracks: () => tracks }));
  const summariser =
    summarise ||
    jest.fn(async (request) =>
      request.mode === "window"
        ? { ok: true, result: summaryResult(`window ${request.segments[0].seq}`) }
        : { ok: true, result: summaryResult("final account") }
    );

  const bridge = installListenInCloudSync({
    uid,
    workspaceId: WS,
    approved,
    store: listenInStore,
    storage: localStorage,
    now: () => clock,
  });
  const sync = createCloudSync({
    workspaceId: WS,
    store: cloud,
    storage: localStorage,
    payloadProviders: bridge.providers,
    isOnline: () => isOnlineValue,
    addOnlineListener: (fn) => {
      onlineListener = fn;
      return () => {
        onlineListener = null;
      };
    },
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => clock,
  }).start();

  const engine = getListenInEngine(uid, WS, {
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
    isOnline: () => true, // the transcription network is not the cloud's
    addOnlineListener: () => () => {},
    addWakeListener: () => () => {},
    newSessionId: () => `meeting-${(minted += 1)}`,
  });

  return {
    engine,
    bridge,
    sync,
    cloud,
    listenInStore,
    getUserMedia,
    tracks,
    summarise: summariser,
    roll: () => roll && roll(),
    advance: (ms) => {
      clock += ms;
    },
    setOnline: (value) => {
      isOnlineValue = value;
      if (value && onlineListener) onlineListener();
    },
    /** Let the engine's drain, the bridge's chains and one cloud flush run.
     *  Nothing summarises on its own (2026-09-13): see `summarise`. */
    async flushAll() {
      await settle();
      await engine.flush();
      await settle();
      await engine.flushSummary();
      await settle();
      await bridge.store.idle();
      await sync.flush();
      await settle();
    },
    /** The user presses Summarise; the request, the bridge and one cloud flush run. */
    async summarise() {
      await engine.summariseNow();
      await settle();
      await engine.flushSummary();
      await settle();
      await bridge.store.idle();
      await sync.flush();
      await settle();
    },
    stop() {
      sync.stop();
      bridge.uninstall();
    },
  };
}

async function begin(r) {
  await r.engine.bootstrap();
  await settle();
  await r.engine.start({ language: "en" });
  await settle();
}

/** Seal one chunk and let the drain have its pass. */
async function speak(r, times = 1) {
  for (let i = 0; i < times; i++) {
    r.advance(30000);
    r.roll();
    await settle();
  }
  await r.engine.flush();
  await settle();
}

const sessionIdOf = (r) => r.engine.getSnapshot().session.sessionId;
const cloudDocs = (r, collection) => r.cloud.listWorkspaceDocs(WS, collection);
const cloudDoc = (r, collection, id) => r.cloud.get(["workspaces", WS, collection, id]);
const parseJson = (doc) => JSON.parse(doc.json);

/* =========================== 1–5. CLOUD DATA ============================= */

describe("1–5. what reaches the account", () => {
  test("1/2/3. a completed meeting syncs its header, its transcript in sequence order and its structured summary", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 3);
    // Complete SEALS the chunk in progress (real speech the user just gave),
    // so a meeting of three rolls has four segments.
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own

    const id = sessionIdOf(r);
    expect(Object.keys(cloudDocs(r, MEETINGS))).toEqual([id]);
    const header = cloudDoc(r, MEETINGS, id);
    expect(header).toMatchObject({
      kind: MEETINGS,
      workspaceId: WS,
      id,
      sessionId: id,
      createdBy: UID,
      state: LISTEN_IN_STATE.FINISHED,
      stopReason: "user",
      segmentCount: 4,
      transcribedThroughSeq: 3,
      pendingCount: 0,
      failedSeqs: [],
      transcriptPageCount: 1,
      language: "en",
    });
    expect(header.capturedMs).toBe(90000);
    expect(header.completedAt).toBeGreaterThan(0);
    expect(header.revision).toBeGreaterThanOrEqual(1);

    const page = cloudDoc(r, TRANSCRIPTS, transcriptPageDocumentId(id, 0));
    expect(page).toMatchObject({ kind: TRANSCRIPTS, sessionId: id, page: 0 });
    const payload = parseJson(page);
    expect(payload.segments.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    expect(payload.segments.every((s) => s.state === CHUNK_STATE.TRANSCRIBED && s.text === WORDS)).toBe(true);
    expect(payload.segments.map((s) => s.offsetMs)).toEqual([0, 30000, 60000, 90000]);

    const summary = cloudDoc(r, SUMMARIES, id);
    expect(summary).toMatchObject({ kind: SUMMARIES, sessionId: id });
    const s = parseJson(summary);
    expect(s.final).toBe(true);
    expect(s.result.summaryText).toBe("final account");
    expect(s.result.actionItems[0]).toMatchObject({ task: "Order pipes", owner: "Sam", sourceSeq: 0 });
    expect(typeof s.result.actionItems[0].id).toBe("string");
    expect(s.summaryRevision).toBe(r.engine.getSnapshot().summary.revision);
    expect(header.summaryRevision).toBe(s.summaryRevision);
    expect(header.summaryFinal).toBe(true);
    expect(r.sync.getStatus()).toMatchObject({ status: SYNC_STATUS.IDLE, pending: 0 });
    r.stop();
  });

  test("4. a four-hour transcript is replicated as bounded pages, not one document", async () => {
    const listenInStore = createListenInMemoryStore();
    const startedAt = 1_700_000_000_000;
    const session = { ...createSession({ sessionId: "meeting-4h", uid: UID, workspaceId: WS, startedAt, language: "en" }), state: LISTEN_IN_STATE.FINISHED, stoppedAt: startedAt + 480 * 30000, capturedMs: 480 * 30000, nextSeq: 480 };
    await listenInStore.putSession(session);
    for (let seq = 0; seq < 480; seq++) {
      const row = createChunk({ uid: UID, workspaceId: WS, sessionId: "meeting-4h", seq, mimeType: "audio/webm", byteLength: 1, startedAt: startedAt + seq * 30000, endedAt: startedAt + (seq + 1) * 30000, language: "en" });
      await listenInStore.putChunk({ ...row, state: CHUNK_STATE.TRANSCRIBED, text: `segment ${seq} ${WORDS.slice(0, 400)}` }, null);
    }
    const r = rig({ listenInStore });
    // Nothing was captured while the rows were written (no bridge existed):
    // the session-start reconcile derives every obligation from the rows.
    const reconciled = await r.bridge.reconcile();
    expect(reconciled.sessions).toBe(1);
    expect(reconciled.enqueued).toHaveLength(1 + 8);
    await r.sync.flush();
    await settle();

    const pages = cloudDocs(r, TRANSCRIPTS);
    expect(Object.keys(pages).sort()).toEqual(Array.from({ length: 8 }, (_, i) => transcriptPageDocumentId("meeting-4h", i)).sort());
    let total = 0;
    for (const doc of Object.values(pages)) {
      expect(doc.chunked).not.toBe(true);
      const payload = parseJson(doc);
      expect(payload.segments.length).toBeLessThanOrEqual(60);
      total += payload.segments.length;
    }
    expect(total).toBe(480);
    expect(cloudDoc(r, MEETINGS, "meeting-4h")).toMatchObject({ transcriptPageCount: 8, transcriptPageSize: 60, segmentCount: 480, transcribedThroughSeq: 479 });
    r.stop();
  });

  test("5. coverage and failure state sync: a failed segment is a failure in the header and on its page, never a fabricated gap", async () => {
    let calls = 0;
    const r = rig({
      transcribe: async () => {
        calls += 1;
        if (calls === 2) throw new Error("bad audio"); // not recoverable → permanent
        return WORDS;
      },
    });
    await begin(r);
    await speak(r, 3);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    const id = sessionIdOf(r);
    expect(cloudDoc(r, MEETINGS, id)).toMatchObject({ state: LISTEN_IN_STATE.FINISHED, failedSeqs: [1], transcribedThroughSeq: 0, pendingCount: 0, segmentCount: 4 });
    const page = parseJson(cloudDoc(r, TRANSCRIPTS, transcriptPageDocumentId(id, 0)));
    expect(page.segments[1]).toMatchObject({ seq: 1, state: CHUNK_STATE.FAILED, text: "" });
    expect(page.segments[2]).toMatchObject({ seq: 2, state: CHUNK_STATE.TRANSCRIBED });
    const summary = parseJson(cloudDoc(r, SUMMARIES, id));
    expect(summary.missingSeqs).toEqual([1]);
    r.stop();
  });
});

/* ============================= 6–9. AUDIO ================================ */

describe("6–9. audio stays on this device", () => {
  test("6/7/8. no committed document carries a Blob, a byte length or a MIME type; nothing reaches Storage or the asset queue", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 2);
    await r.engine.pause();
    await r.flushAll();
    await r.engine.resume();
    await speak(r, 1);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own

    const everything = r.cloud.dump();
    const listenInDocs = Object.entries(everything).filter(([key]) => /\/(listenInMeetings|listenInTranscripts|listenInSummaries)\//.test(key));
    expect(listenInDocs.length).toBeGreaterThanOrEqual(3);
    for (const [key, doc] of listenInDocs) {
      expect({ key, binary: findBinaryInPayload(doc) }).toEqual({ key, binary: null });
      const text = JSON.stringify(doc);
      expect({ key, hit: /"audio"|byteLength|mimeType|audio\/webm/.test(text) }).toEqual({ key, hit: false });
    }
    // No asset metadata document and no Storage object: the Listen In path
    // has no way to reach either, and none was created.
    expect(Object.keys(everything).filter((key) => key.includes("/assets/"))).toEqual([]);
    expect(await countPendingAssetUploads(WS)).toBe(0);
    // Every commit the cloud saw was a Listen In text document or its chunk.
    for (const batch of r.cloud.calls.commits) {
      for (const op of batch) {
        expect(op.path).toMatch(/^(listenInMeetings|listenInTranscripts|listenInSummaries)\//);
      }
    }
    r.stop();
  });

  test("9. a failed chunk's audio stays local, and the providers never read a chunk's bytes at all", async () => {
    const r = rig({
      transcribe: async () => {
        throw new Error("bad audio");
      },
    });
    await begin(r);
    await speak(r, 1);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise();
    const id = sessionIdOf(r);
    // Two chunks: the roll, and the one Complete sealed. Both failed; both
    // keep their bytes here and nowhere else.
    for (const seq of [0, 1]) {
      const audio = await r.listenInStore.getChunkAudio(UID, WS, id, seq);
      expect(audio).not.toBeNull();
      expect(audio.size).toBe(32);
    }
    expect(cloudDoc(r, MEETINGS, id).failedSeqs).toEqual([0, 1]);
    expect(JSON.stringify(cloudDoc(r, TRANSCRIPTS, transcriptPageDocumentId(id, 0)))).not.toMatch(/audio/);

    // The providers reach the rows through the audio-free listing only: the
    // one call that returns bytes is never made, for any of the three.
    const spied = { ...r.listenInStore, getChunkAudio: jest.fn(async () => new Blob(["never"])) };
    const providers = createListenInPayloadProviders({ uid: UID, workspaceId: WS, store: spied });
    const loaded = await Promise.all([
      providers[MEETINGS].load(WS, id),
      providers[TRANSCRIPTS].load(WS, transcriptPageDocumentId(id, 0)),
      providers[SUMMARIES].load(WS, id),
    ]);
    expect(spied.getChunkAudio).not.toHaveBeenCalled();
    for (const item of loaded) expect(findBinaryInPayload(item.payload)).toBeNull();
    // And the guard behind them is live: a payload with binary is refused
    // with its own code, so such an entry could only ever FAIL, not upload.
    expect(() => assertNoBinaryInPayload({ segments: [{ audio: new Blob(["x"]) }] })).toThrow(expect.objectContaining({ code: LISTEN_IN_BINARY_PAYLOAD_CODE }));
    r.stop();
  });
});

/* =========================== 10–16. LOCAL-FIRST ========================== */

describe("10–16. local first, cloud asynchronous", () => {
  test("10/11/12/13/14. with the cloud unreachable, recording, Stop, Start again and Complete all succeed locally and the work queues", async () => {
    const r = rig({ online: false });
    await begin(r);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    await speak(r, 2);
    expect(r.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(r.engine.getSnapshot().chunks).toHaveLength(2);

    await r.engine.pause();
    await settle();
    expect(r.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(currentMicrophoneOwner()).toBeNull();

    await r.engine.resume();
    await settle();
    expect(r.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(r.getUserMedia).toHaveBeenCalledTimes(2);
    await speak(r, 1);

    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    const snap = r.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.active).toBe(false);
    // two rolls + the Stop seal + one roll + the Complete seal
    expect(snap.chunks).toHaveLength(5);
    expect(transcriptText(snap.chunks)).toBe(Array(5).fill(WORDS).join(" "));
    expect(snap.summary.final).toBe(true);
    expect(snap.error).toBeNull();

    // Nothing reached the cloud; everything is queued and the engine says so.
    expect(Object.keys(cloudDocs(r, MEETINGS))).toEqual([]);
    expect(outboxSize(WS, localStorage)).toBe(3);
    expect(r.sync.getStatus().status).toBe(SYNC_STATUS.OFFLINE);
    r.stop();
  });

  test("15. reconnecting flushes the queued meeting", async () => {
    const r = rig({ online: false });
    await begin(r);
    await speak(r, 1);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    expect(Object.keys(cloudDocs(r, MEETINGS))).toEqual([]);
    const outcomes = [];
    r.sync.subscribe((event) => {
      if (event.type === "outcome") outcomes.push(...event.results);
    });
    r.setOnline(true); // the browser's `online` event wakes the engine
    await settle();
    await settle();
    const id = sessionIdOf(r);
    expect(cloudDoc(r, MEETINGS, id)).toMatchObject({ state: LISTEN_IN_STATE.FINISHED });
    expect(cloudDoc(r, TRANSCRIPTS, transcriptPageDocumentId(id, 0))).toBeTruthy();
    expect(cloudDoc(r, SUMMARIES, id)).toBeTruthy();
    expect(outcomes.filter((o) => o.outcome === SYNC_OUTCOME.SYNCED)).toHaveLength(3);
    expect(outboxSize(WS, localStorage)).toBe(0);
    r.stop();
  });

  test("16. a reload resumes the queued cloud work from the outbox and the rows alone", async () => {
    const listenInStore = createListenInMemoryStore();
    const cloud = workspaceStore();
    const first = rig({ online: false, listenInStore, cloud });
    await begin(first);
    await speak(first, 1);
    await first.engine.complete();
    await first.flushAll();
    await first.summarise();
    const id = sessionIdOf(first);
    expect(outboxSize(WS, localStorage)).toBe(3);
    first.stop();
    resetListenInEnginesForTests(); // the process dies; localStorage and IndexedDB do not

    const second = rig({ online: true, listenInStore, cloud });
    // A fresh session start: the engine replays the outbox with no help from
    // any engine snapshot — the rows and the bookkeeping are enough.
    await second.sync.flush();
    await settle();
    expect(cloudDoc(second, MEETINGS, id)).toMatchObject({ state: LISTEN_IN_STATE.FINISHED, segmentCount: 2 });
    expect(parseJson(cloudDoc(second, TRANSCRIPTS, transcriptPageDocumentId(id, 0))).segments[0].text).toBe(WORDS);
    expect(outboxSize(WS, localStorage)).toBe(0);
    second.stop();
  });

  test("a transient cloud failure keeps the entry queued and a later flush lands it; a refused outbox never reaches the engine", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 1);
    await r.bridge.store.idle();
    r.cloud.failNext("commit", "unavailable");
    const result = await r.sync.flush();
    expect(result.ok).toBe(false);
    expect(result.results.every((o) => o.outcome === SYNC_OUTCOME.QUEUED)).toBe(true);
    expect(r.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(r.engine.getSnapshot().error).toBeNull();
    await r.sync.flush();
    await settle();
    expect(cloudDoc(r, MEETINGS, sessionIdOf(r))).toMatchObject({ state: LISTEN_IN_STATE.RECORDING });
    r.stop();
  });
});

/* ============================ 17–21. CONFLICTS =========================== */

describe("17–21. revisions and conflicts", () => {
  test("17. a replayed write is idempotent: the same revision lands again without error and nothing changes", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 1);
    await r.flushAll();
    const id = sessionIdOf(r);
    const before = cloudDoc(r, MEETINGS, id);
    // The identity is re-queued (a lost settle, a duplicate capture) and
    // flushed again: same content, same revision, accepted.
    captureExternalChanges(WS, [{ collection: MEETINGS, id, op: OUTBOX_OP.UPSERT }, { collection: TRANSCRIPTS, id: transcriptPageDocumentId(id, 0), op: OUTBOX_OP.UPSERT }]);
    const result = await r.sync.flush();
    expect(result.ok).toBe(true);
    expect(result.results.every((o) => o.outcome === SYNC_OUTCOME.SYNCED)).toBe(true);
    const after = cloudDoc(r, MEETINGS, id);
    expect(after.revision).toBe(before.revision);
    expect(after.segmentCount).toBe(before.segmentCount);
    r.stop();
  });

  test("18/20. a stale transcript or summary write cannot overwrite a newer cloud revision", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 1);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    const id = sessionIdOf(r);
    // Another device already holds a NEWER revision of the page and the summary.
    const pageId = transcriptPageDocumentId(id, 0);
    const newerPage = { ...cloudDoc(r, TRANSCRIPTS, pageId), revision: 99, json: JSON.stringify({ ...parseJson(cloudDoc(r, TRANSCRIPTS, pageId)), revision: 99 }) };
    r.cloud.seed(["workspaces", WS, TRANSCRIPTS, pageId], newerPage);
    const newerSummary = { ...cloudDoc(r, SUMMARIES, id), revision: 50 };
    r.cloud.seed(["workspaces", WS, SUMMARIES, id], newerSummary);
    captureExternalChanges(WS, [{ collection: TRANSCRIPTS, id: pageId, op: OUTBOX_OP.UPSERT }]);
    let result = await r.sync.flush();
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({ outcome: SYNC_OUTCOME.FAILED, code: "permission-denied" });
    expect(cloudDoc(r, TRANSCRIPTS, pageId).revision).toBe(99);
    clearOutbox(WS, localStorage);
    captureExternalChanges(WS, [{ collection: SUMMARIES, id, op: OUTBOX_OP.UPSERT }]);
    result = await r.sync.flush();
    expect(result.results[0]).toMatchObject({ outcome: SYNC_OUTCOME.FAILED, code: "permission-denied" });
    expect(cloudDoc(r, SUMMARIES, id).revision).toBe(50);
    r.stop();
  });

  test("19. a regenerated summary syncs as a newer revision, and the header follows it", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 1);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    const id = sessionIdOf(r);
    const before = cloudDoc(r, SUMMARIES, id);
    const beforeRevision = before.revision;
    const beforeSummaryRevision = parseJson(before).summaryRevision;
    await r.engine.regenerateSummary();
    await r.flushAll();
    await r.flushAll();
    const after = cloudDoc(r, SUMMARIES, id);
    expect(after.revision).toBeGreaterThan(beforeRevision);
    expect(parseJson(after).summaryRevision).toBeGreaterThan(beforeSummaryRevision);
    expect(cloudDoc(r, MEETINGS, id).summaryRevision).toBe(parseJson(after).summaryRevision);
    r.stop();
  });

  test("21. Stop/Start cycles mint no new meeting and an unchanged header costs no revision", async () => {
    const r = rig();
    await begin(r);
    const id = sessionIdOf(r);
    for (let i = 0; i < 3; i++) {
      await speak(r, 1);
      await r.engine.pause();
      await settle();
      await r.engine.resume();
      await settle();
    }
    await r.flushAll();
    expect(Object.keys(cloudDocs(r, MEETINGS))).toEqual([id]);
    expect(sessionIdOf(r)).toBe(id);
    const revision = cloudDoc(r, MEETINGS, id).revision;
    // Re-writing the same header (a seal that only advances nextSeq, a
    // repeated save) changes no projection: no revision, no outbox entry.
    const session = await r.listenInStore.getSession(UID, WS, id);
    await r.bridge.store.putSession({ ...session, nextSeq: session.nextSeq + 1 });
    await r.bridge.store.putSession({ ...session, nextSeq: session.nextSeq + 2 });
    await r.bridge.store.idle();
    expect(outboxSize(WS, localStorage)).toBe(0);
    expect((await r.listenInStore.getSyncState(UID, WS, id, "meeting")).revision).toBe(revision);
    r.stop();
  });
});

/* ================== 22–26. THE CREATOR, ON ANOTHER DEVICE ================ */
//
// "Another device" means ANOTHER DEVICE OF THE PERSON WHO RECORDED THE
// MEETING. A Listen In meeting is stored under its workspace but is private
// to its creator until an explicit Share/Inbox step exists, so a second
// member of the same workspace is proved to get NOTHING.

describe("22–26. the same creator on another device, and nobody else", () => {
  async function completedMeeting() {
    let calls = 0;
    const r = rig({
      transcribe: async () => {
        calls += 1;
        if (calls === 2) throw new Error("bad audio");
        return WORDS;
      },
    });
    await begin(r);
    await speak(r, 3);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    return r;
  }

  test("22/23/24/25. the creator's second device hydrates the metadata, the ordered transcript, the summary and the exact coverage", async () => {
    const r = await completedMeeting();
    const id = sessionIdOf(r);
    const local = r.engine.getSnapshot();
    // The SAME account, signed in on a different device: a fresh local Listen
    // In store with none of this meeting's rows, reading the account.
    const secondDevice = createListenInMemoryStore();
    expect(await secondDevice.listSessions(UID, WS)).toEqual([]);
    r.cloud.setUser(UID);

    const read = await loadCloudListenInMeeting({ store: r.cloud, workspaceId: WS, sessionId: id, uid: UID });
    expect(read.ok).toBe(true);
    expect(read.meeting).toMatchObject({ sessionId: id, createdBy: UID, state: LISTEN_IN_STATE.FINISHED, capturedMs: 90000, language: "en", failedSeqs: [1] });
    expect(read.segments.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    expect(read.segments.map((s) => s.state)).toEqual([CHUNK_STATE.TRANSCRIBED, CHUNK_STATE.FAILED, CHUNK_STATE.TRANSCRIBED, CHUNK_STATE.TRANSCRIBED]);
    expect(transcriptText(read.chunks)).toBe(transcriptText(local.chunks));
    expect(read.pages).toEqual({ present: [0], expected: 1, missing: [] });
    expect(read.summary.result.summaryText).toBe(local.summary.result.summaryText);
    expect(read.summary.result.actionItems[0].task).toBe("Order pipes");
    expect(read.summary.final).toBe(true);
    expect(read.summary.missingSeqs).toEqual([1]);
    expect(read.coverage).toMatchObject({ failedCount: 1, pendingCount: 0, missingSeqs: [1], complete: true, capturing: false });
    expect(read.malformed).toEqual([]);
    const listing = await listCloudListenInMeetings({ store: r.cloud, workspaceId: WS, uid: UID });
    expect(listing.meetings.map((m) => m.sessionId)).toEqual([id]);
    // Reading the account changed nothing on that second device.
    expect(await secondDevice.listSessions(UID, WS)).toEqual([]);
    r.stop();
  });

  test("another ORDINARY MEMBER of the same workspace can neither list, read, update nor delete the meeting", async () => {
    const r = await completedMeeting();
    const id = sessionIdOf(r);
    const pageId = transcriptPageDocumentId(id, 0);
    const header = { ...cloudDoc(r, MEETINGS, id) };
    delete header.updatedAt;

    r.cloud.setUser(OTHER); // Bob: a member of this workspace, not the creator
    // LIST: the caller may only ever ask for their own, and gets none.
    expect((await r.cloud.listListenInMeetings(WS, OTHER)).meetings).toEqual([]);
    expect((await listCloudListenInMeetings({ store: r.cloud, workspaceId: WS, uid: OTHER })).meetings).toEqual([]);
    // ...and cannot ask for somebody else's.
    await expect(r.cloud.listListenInMeetings(WS, UID)).rejects.toMatchObject({ code: "permission-denied" });
    // READ: refused for the header, and for the pages and summary with it.
    await expect(r.cloud.readListenInMeeting(WS, id, OTHER)).rejects.toMatchObject({ code: "permission-denied" });
    // The read model does not soften that into an empty result: a refusal is
    // reported as one, so a caller can tell "not allowed" from "not there".
    await expect(loadCloudListenInMeeting({ store: r.cloud, workspaceId: WS, sessionId: id, uid: OTHER })).rejects.toMatchObject({
      code: "permission-denied",
    });
    // UPDATE: refused on all three, even with a higher revision.
    for (const op of [
      { path: [MEETINGS, id], fields: { ...header, revision: header.revision + 5 } },
      { path: [TRANSCRIPTS, pageId], fields: { ...cloudDoc(r, TRANSCRIPTS, pageId), updatedAt: undefined, revision: 99 } },
      { path: [SUMMARIES, id], fields: { ...cloudDoc(r, SUMMARIES, id), updatedAt: undefined, revision: 99 } },
    ]) {
      const fields = { ...op.fields };
      delete fields.updatedAt;
      await expect(r.cloud.commitBatch(WS, [{ type: "set", path: op.path, fields }])).rejects.toMatchObject({ code: "permission-denied" });
    }
    // DELETE: refused on all three.
    for (const path of [[MEETINGS, id], [TRANSCRIPTS, pageId], [SUMMARIES, id]]) {
      await expect(r.cloud.commitBatch(WS, [{ type: "delete", path }])).rejects.toMatchObject({ code: "permission-denied" });
    }
    // Everything is exactly as the creator left it.
    r.cloud.setUser(UID);
    expect(cloudDoc(r, MEETINGS, id)).toMatchObject({ createdBy: UID, revision: header.revision });
    expect((await loadCloudListenInMeeting({ store: r.cloud, workspaceId: WS, sessionId: id, uid: UID })).ok).toBe(true);
    r.stop();
  });

  test("26. no device is offered a retry from cloud state; only the device holding the audio is", async () => {
    const r = await completedMeeting();
    const id = sessionIdOf(r);
    r.cloud.setUser(UID);
    const read = await loadCloudListenInMeeting({ store: r.cloud, workspaceId: WS, sessionId: id, uid: UID });
    // The creator's own second device sees the failure and is still offered
    // no retry: the audio is on the device that recorded it, not in the cloud.
    expect(read.retry).toEqual({ available: false, seqs: [], reason: RETRY_UNAVAILABLE_REASON });
    expect(read.segments[1]).toMatchObject({ seq: 1, state: CHUNK_STATE.FAILED, text: "" });
    const secondDevice = await listenInRetryAvailability({ store: createListenInMemoryStore(), uid: UID, workspaceId: WS, sessionId: id, chunks: read.chunks });
    expect(secondDevice.available).toBe(false);
    expect(secondDevice.reason).toBe(RETRY_UNAVAILABLE_REASON);
    // The recording device really can retry: the failed chunk's audio is here.
    const recording = await listenInRetryAvailability({ store: r.listenInStore, uid: UID, workspaceId: WS, sessionId: id, chunks: r.engine.getSnapshot().chunks });
    expect(recording).toEqual({ available: true, seqs: [1], reason: null });
    r.stop();
  });

  test("a non-member reads nothing, and a malformed cloud page is reported rather than read as empty", async () => {
    const r = await completedMeeting();
    const id = sessionIdOf(r);
    r.cloud.setUser("carol");
    await expect(loadCloudListenInMeeting({ store: r.cloud, workspaceId: WS, sessionId: id, uid: "carol" })).rejects.toMatchObject({ code: "permission-denied" });
    r.cloud.setUser(UID);
    const pageId = transcriptPageDocumentId(id, 0);
    r.cloud.seed(["workspaces", WS, TRANSCRIPTS, pageId], { ...cloudDoc(r, TRANSCRIPTS, pageId), json: "{not json" });
    const read = await loadCloudListenInMeeting({ store: r.cloud, workspaceId: WS, sessionId: id, uid: UID });
    expect(read.ok).toBe(true);
    expect(read.malformed).toEqual([{ collection: TRANSCRIPTS, id: pageId, reason: "bad-json" }]);
    expect(read.pages.missing).toEqual([0]);
    expect(read.segments).toEqual([]);
    r.stop();
  });
});

/* ======================== 27–31. IDENTITY / LIFECYCLE ==================== */

describe("27–31. identity and the active meeting", () => {
  test("27. createdBy is the recording account, and cannot be written as someone else", async () => {
    const r = rig();
    await begin(r);
    await r.flushAll();
    const id = sessionIdOf(r);
    expect(cloudDoc(r, MEETINGS, id).createdBy).toBe(UID);
    // Bob (a member) cannot create a header naming Alice as its author, nor
    // re-author hers — the memory store refuses exactly as the rules do.
    r.cloud.setUser(OTHER);
    const header = { ...cloudDoc(r, MEETINGS, id) };
    delete header.updatedAt;
    await expect(r.cloud.commitBatch(WS, [{ type: "set", path: [MEETINGS, "bob-fake"], fields: { ...header, id: "bob-fake", sessionId: "bob-fake", createdBy: UID } }])).rejects.toMatchObject({ code: "permission-denied" });
    await expect(r.cloud.commitBatch(WS, [{ type: "set", path: [MEETINGS, id], fields: { ...header, createdBy: OTHER, revision: header.revision + 1 } }])).rejects.toMatchObject({ code: "permission-denied" });
    expect(cloudDoc(r, MEETINGS, id).createdBy).toBe(UID);
    r.stop();
  });

  test("28. a completed meeting — in the cloud and in the local store — is not mistaken for the active one", async () => {
    const listenInStore = createListenInMemoryStore();
    const r = rig({ listenInStore });
    await begin(r);
    await speak(r, 1);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    const id = sessionIdOf(r);
    expect(cloudDoc(r, MEETINGS, id).state).toBe(LISTEN_IN_STATE.FINISHED);
    r.stop();
    resetListenInEnginesForTests();
    const again = rig({ listenInStore, cloud: r.cloud });
    await again.engine.bootstrap();
    await settle();
    expect(again.engine.getSnapshot().session).toBeNull();
    expect(again.engine.getSnapshot().active).toBe(false);
    await again.engine.start({ language: "en" });
    await settle();
    expect(sessionIdOf(again)).not.toBe(id);
    await again.flushAll();
    expect(Object.keys(cloudDocs(again, MEETINGS)).sort()).toEqual([id, sessionIdOf(again)].sort());
    again.stop();
  });

  test("29/30. a stopped meeting stays active and recoverable, and an interrupted one too — locally and as replicated", async () => {
    const listenInStore = createListenInMemoryStore();
    const r = rig({ listenInStore });
    await begin(r);
    await speak(r, 1);
    await r.engine.pause();
    await r.flushAll();
    const id = sessionIdOf(r);
    expect(cloudDoc(r, MEETINGS, id)).toMatchObject({ state: LISTEN_IN_STATE.PAUSED, stopReason: null, stoppedAt: null, completedAt: null, capturedMs: 30000 });
    expect(r.engine.getSnapshot().active).toBe(true);
    r.stop();
    resetListenInEnginesForTests();

    const back = rig({ listenInStore, cloud: r.cloud });
    await back.engine.bootstrap();
    await settle();
    expect(back.engine.getSnapshot().session.sessionId).toBe(id);
    expect(back.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(back.engine.getSnapshot().active).toBe(true);
    await back.engine.resume();
    await settle();
    await speak(back, 1);
    back.advance(1000);
    // The process dies mid-recording: the next engine recovers it INTERRUPTED.
    back.stop();
    resetMicrophoneOwnershipForTests();
    resetListenInEnginesForTests();

    const recovered = rig({ listenInStore, cloud: r.cloud });
    await recovered.engine.bootstrap();
    await settle();
    const snap = recovered.engine.getSnapshot();
    expect(snap.session.sessionId).toBe(id);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(snap.active).toBe(true);
    // the first roll, the Stop seal, and the second leg's roll
    expect(snap.chunks).toHaveLength(3);
    await recovered.flushAll();
    expect(cloudDoc(recovered, MEETINGS, id)).toMatchObject({ state: LISTEN_IN_STATE.INTERRUPTED, stopReason: "interruption", segmentCount: 3 });
    recovered.stop();
  });

  test("31. hydrating cloud meetings writes nothing to the local store and cannot create a second active meeting", async () => {
    const listenInStore = createListenInMemoryStore();
    const cloud = workspaceStore();
    // Another device completed a meeting into the account earlier.
    const other = rig({ listenInStore: createListenInMemoryStore(), cloud });
    await begin(other);
    await speak(other, 1);
    await other.engine.complete();
    await other.flushAll();
    await other.flushAll();
    const completedId = sessionIdOf(other);
    other.stop();
    resetListenInEnginesForTests();
    // And a NEWER unfinished one that is still recording on that device.
    const live = rig({ listenInStore: createListenInMemoryStore(), cloud });
    await begin(live);
    await speak(live, 1);
    await live.flushAll();
    const liveId = sessionIdOf(live);
    live.stop();
    resetMicrophoneOwnershipForTests();
    resetListenInEnginesForTests();

    // THIS device has its own stopped meeting.
    const mine = rig({ listenInStore, cloud });
    await begin(mine);
    await speak(mine, 1);
    await mine.engine.pause();
    await mine.flushAll();
    const myId = sessionIdOf(mine);

    const before = (await listenInStore.listSessions(UID, WS)).map((s) => s.sessionId);
    const listing = await listCloudListenInMeetings({ store: cloud, workspaceId: WS, uid: UID });
    expect(listing.meetings.map((m) => m.sessionId).sort()).toEqual([completedId, liveId, myId].sort());
    const read = await loadCloudListenInMeeting({ store: cloud, workspaceId: WS, sessionId: completedId, uid: UID });
    expect(read.ok).toBe(true);
    const readLive = await loadCloudListenInMeeting({ store: cloud, workspaceId: WS, sessionId: liveId, uid: UID });
    expect(readLive.meeting.state).toBe(LISTEN_IN_STATE.RECORDING);
    // Nothing was written locally by any of that.
    expect((await listenInStore.listSessions(UID, WS)).map((s) => s.sessionId)).toEqual(before);
    expect(before).toEqual([myId]);
    // And a fresh engine still finds exactly this device's meeting.
    mine.stop();
    resetListenInEnginesForTests();
    const again = rig({ listenInStore, cloud });
    await again.engine.bootstrap();
    await settle();
    expect(again.engine.getSnapshot().session.sessionId).toBe(myId);
    expect(again.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(again.engine.getSnapshot().active).toBe(true);
    again.stop();
  });

  test("a discard queues the cloud deletes first and removes the meeting from the account", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 1);
    await r.engine.pause();
    await r.flushAll();
    const id = sessionIdOf(r);
    expect(cloudDoc(r, MEETINGS, id)).toBeTruthy();
    await r.engine.discard();
    await r.flushAll();
    expect(cloudDoc(r, MEETINGS, id)).toBeNull();
    expect(cloudDoc(r, TRANSCRIPTS, transcriptPageDocumentId(id, 0))).toBeNull();
    expect(cloudDoc(r, SUMMARIES, id)).toBeNull();
    expect(await r.listenInStore.listSyncStates(UID, WS, id)).toEqual([]);
    r.stop();
  });
});

/* ===================== the local bookkeeping holds no text =============== */

describe("listenInCloudState stores revisions and a digest, never the words", () => {
  test("no bookkeeping row contains any transcript or summary text, at any depth", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 2);
    await r.engine.complete();
    await r.flushAll();
    await r.summarise(); // the user asks for the summary; nothing summarises on its own
    const id = sessionIdOf(r);
    const snapshot = r.engine.getSnapshot();
    const spokenWords = WORDS.split(" ").filter((w) => w.length > 3);
    const summaryText = snapshot.summary.result.summaryText;
    expect(transcriptText(snapshot.chunks)).toContain("eastern boundary");
    expect(summaryText).toBeTruthy();

    const rows = await r.listenInStore.listSyncStates(UID, WS, id);
    // header + one transcript page + summary
    expect(rows.map((row) => row.entity).sort()).toEqual(["meeting", "summary", "transcript:0"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["chunks", "entity", "revision", "sessionId", "signature", "syncedRevision", "uid", "updatedAt", "workspaceId"]
      );
      const serialised = JSON.stringify(row);
      for (const word of spokenWords) expect({ entity: row.entity, word, hit: serialised.includes(word) }).toEqual({ entity: row.entity, word, hit: false });
      expect(serialised).not.toContain(summaryText);
      expect(serialised).not.toContain("Order pipes");
      expect(serialised).not.toContain("Drainage agreed");
      expect(findBinaryInPayload(row)).toBeNull();
      // The signature is the fixed-shape digest, not the projection.
      expect(row.signature.startsWith(`${SIGNATURE_VERSION}:`)).toBe(true);
      expect(row.signature.length).toBeLessThan(40);
      expect(row.revision).toBeGreaterThanOrEqual(1);
      expect(row.syncedRevision).toBe(row.revision);
    }
    // The whole store is small however long the meeting was.
    const allRows = JSON.stringify(await r.listenInStore.listSyncStates(UID, WS));
    expect(allRows.length).toBeLessThan(1200);
    r.stop();
  });

  test("a change to the words still changes the digest, so replication is not lost by shrinking the row", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 1);
    await r.flushAll();
    const id = sessionIdOf(r);
    const before = await r.listenInStore.getSyncState(UID, WS, id, "transcript:0");
    await speak(r, 1);
    await r.flushAll();
    const after = await r.listenInStore.getSyncState(UID, WS, id, "transcript:0");
    expect(after.signature).not.toBe(before.signature);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(JSON.parse(cloudDoc(r, TRANSCRIPTS, transcriptPageDocumentId(id, 0)).json).segments).toHaveLength(2);
    r.stop();
  });
});

/* ========================= the repair and the decorator ================== */

describe("the reconcile and the decorator", () => {
  test("a lost outbox identity is re-derived from the rows; an accepted revision is not re-queued", async () => {
    const r = rig();
    await begin(r);
    await speak(r, 1);
    await r.flushAll();
    const id = sessionIdOf(r);
    expect(outboxSize(WS, localStorage)).toBe(0);
    // Everything accepted: the reconcile finds nothing owed.
    expect((await r.bridge.reconcile()).enqueued).toEqual([]);
    // A write whose bookkeeping was lost (the crash window): the row changed
    // under the bridge's back, and the bookkeeping still says "accepted".
    const session = await r.listenInStore.getSession(UID, WS, id);
    await r.listenInStore.putSession({ ...session, title: "Renamed after the crash" });
    const reconciled = await r.bridge.reconcile();
    expect(reconciled.enqueued).toEqual([`${MEETINGS}/${id}`]);
    await r.sync.flush();
    await settle();
    expect(cloudDoc(r, MEETINGS, id).title).toBe("Renamed after the crash");
    // A stale settle (an older token) never marks a newer revision accepted.
    const state = await r.listenInStore.getSyncState(UID, WS, id, "meeting");
    expect(await r.bridge.providers[MEETINGS].settle(WS, id, state.revision - 1)).toBe(false);
    expect((await r.listenInStore.getSyncState(UID, WS, id, "meeting")).syncedRevision).toBe(state.revision);
    r.stop();
  });

  test("the decorator captures only this account's rows, never blocks a write, and passes reads through untouched", async () => {
    const inner = createListenInMemoryStore();
    const captured = [];
    const store = withListenInCloudCapture(inner, { uid: UID, workspaceId: WS, capture: (wid, changes) => captured.push(...changes) });
    const mine = createSession({ sessionId: "s-mine", uid: UID, workspaceId: WS, startedAt: 1, language: "en" });
    const theirs = createSession({ sessionId: "s-theirs", uid: OTHER, workspaceId: WS, startedAt: 1, language: "en" });
    await store.putSession(mine);
    await store.putSession(theirs);
    await store.idle();
    expect(captured).toEqual([{ collection: MEETINGS, id: "s-mine", op: OUTBOX_OP.UPSERT }]);
    expect(await store.getSession(OTHER, WS, "s-theirs")).toEqual(theirs);
    expect(store.survivesReload).toBe(false);
    // A capture that throws costs the engine nothing.
    const throwing = withListenInCloudCapture(createListenInMemoryStore(), {
      uid: UID,
      workspaceId: WS,
      capture: () => {
        throw new Error("outbox refused");
      },
    });
    await expect(throwing.putSession(mine)).resolves.toEqual(mine);
    await throwing.idle();
    expect(await throwing.getSession(UID, WS, "s-mine")).toEqual(mine);
    // Releasing audio changes no projection and is not captured.
    const chunk = createChunk({ uid: UID, workspaceId: WS, sessionId: "s-mine", seq: 0, mimeType: "audio/webm", byteLength: 3, startedAt: 1, endedAt: 2, language: "en" });
    await store.putChunk(chunk, new Blob(["abc"]));
    await store.idle();
    const count = captured.length;
    await store.releaseChunkAudio(UID, WS, "s-mine", 0);
    await store.idle();
    expect(captured.length).toBe(count);
    expect(await store.getChunkAudio(UID, WS, "s-mine", 0)).toBeNull();
  });

  test("a provider for a meeting that is gone locally writes nothing, and a foreign workspace gets nothing", async () => {
    const store = createListenInMemoryStore();
    const providers = createListenInPayloadProviders({ uid: UID, workspaceId: WS, store });
    expect(await providers[MEETINGS].load(WS, "nope")).toBeUndefined();
    expect(await providers[MEETINGS].load("ws-other", "nope")).toBeUndefined();
    expect(await providers[TRANSCRIPTS].load(WS, "not-a-page-id")).toBeUndefined();
    expect(await reconcileListenInOutbox({ uid: "", workspaceId: WS, store })).toEqual({ sessions: 0, enqueued: [] });
  });
});

/* =============================== the session ============================= */

describe("the workspace session", () => {
  const syncOptions = { isOnline: () => true, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {} };
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t) };

  test("the governance flag is ON (approved 2026-09-12): a plain session installs the bridge; an explicit OFF installs nothing", async () => {
    expect(LISTEN_IN_CLOUD_TEXT_SYNC_APPROVED).toBe(true);
    const cloud = createMemoryWorkspaceStore();
    cloud.setUser(UID);
    // The production path: no approval passed, the policy decides. A memory
    // Listen In store is injected only so no IndexedDB is opened here.
    const on = await openWorkspaceSession({ uid: UID, store: cloud, syncOptions, ...timers, listenInCloud: { store: createListenInMemoryStore() } });
    expect(on.listenIn.installed).toBe(true);
    expect(on.listenIn.reconciled).toEqual({ sessions: 0, enqueued: [] });
    expect(registeredListenInStore(UID, on.workspace.id)).not.toBeNull();
    await on.close();
    expect(registeredListenInStore(UID, on.workspace.id)).toBeNull();
    // Turned off again (a test injecting the refusal), nothing is installed
    // and the engine keeps its own store, exactly as before this phase.
    const off = await openWorkspaceSession({ uid: UID, store: cloud, syncOptions, ...timers, listenInCloud: { approved: false } });
    expect(off.listenIn).toEqual({ installed: false, reconciled: null });
    expect(registeredListenInStore(UID, off.workspace.id)).toBeNull();
    const engine = getListenInEngine(UID, off.workspace.id, { persistence: LISTEN_IN_PERSISTENCE.MEMORY, recorderSupported: () => true });
    await engine.bootstrap();
    expect(engine.getSnapshot().session).toBeNull();
    await off.close();
    expect(Object.keys(cloud.dump()).filter((k) => /listenIn/.test(k))).toEqual([]);
  });

  test("with approval injected, the session installs the bridge, hands the engine its store, reconciles at start and uninstalls at close", async () => {
    const cloud = createMemoryWorkspaceStore();
    cloud.setUser(UID);
    const listenInStore = createListenInMemoryStore();
    const opened = await openWorkspaceSession({ uid: UID, store: cloud, syncOptions, ...timers, listenInCloud: { approved: true, store: listenInStore } });
    const wid = opened.workspace.id;
    expect(opened.listenIn.installed).toBe(true);
    expect(registeredListenInStore(UID, wid)).not.toBeNull();
    const engine = getListenInEngine(UID, wid, { recorderSupported: () => true, getUserMedia: async () => ({ getTracks: () => [] }), setInterval_: () => 1, clearInterval_: () => {}, setTimer: () => 0, clearTimer: () => {}, addWakeListener: () => () => {}, addOnlineListener: () => () => {} });
    await engine.bootstrap();
    await engine.start({ language: "en" });
    await settle();
    await registeredListenInStore(UID, wid).idle();
    await opened.sync.flush();
    await settle();
    const id = engine.getSnapshot().session.sessionId;
    expect(cloud.get(["workspaces", wid, MEETINGS, id])).toMatchObject({ createdBy: UID, state: LISTEN_IN_STATE.RECORDING });
    await opened.close();
    expect(registeredListenInStore(UID, wid)).toBeNull();
    engine.shutdown();
  });
});

/* ============================ a direct engine ============================ */

describe("an engine created directly over the decorated store", () => {
  test("behaves exactly like the registry path: the same rows, the same obligations", async () => {
    const listenInStore = createListenInMemoryStore();
    const captured = [];
    const store = withListenInCloudCapture(listenInStore, { uid: UID, workspaceId: WS, capture: (wid, changes) => captured.push(...changes.map((c) => c.collection)) });
    const engine = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store,
      transcribe: async () => WORDS,
      summarise: async () => ({ ok: false, outcome: "failure", message: "off" }),
      summaryEnabled: false,
      recorderSupported: () => true,
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 1,
      clearInterval_: () => {},
      addWakeListener: () => () => {},
      addOnlineListener: () => () => {},
    });
    await engine.start({ language: "en" });
    await settle();
    await store.idle();
    expect(captured).toEqual([MEETINGS]);
    engine.shutdown();
  });
});
