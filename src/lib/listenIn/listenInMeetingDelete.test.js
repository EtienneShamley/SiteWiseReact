// src/lib/listenIn/listenInMeetingDelete.test.js
//
// SAVED MEETING HISTORY AND DELETE MEETING (2026-10-21), proved as behaviour:
// the REAL engine (microphone, recorder, clock and transcription injected)
// over the REAL cloud bridge, the REAL outbox and capture, the REAL sync
// engine and the in-memory workspace store that enforces what the Security
// Rules enforce — the same rig as listenInCloudSync.test.js.
//
//   HISTORY   one entry per meeting id: Stop recording / Start recording legs
//             never mint an entry; separate meetings keep theirs; a duplicate
//             header cannot double one; a multi-leg meeting opens whole
//   DELETE    only a COMPLETED meeting; the whole meeting — header, chunks,
//             summary, bookkeeping, and its cloud header / transcript pages /
//             summary; nothing else; a queued upsert or the reconcile cannot
//             bring it back; another account cannot reach it
//   SEMANTICS Clear deletes nothing; Discard stays the unfinished meeting's
//             delete; the active meeting is never touched by a history delete
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
import { installListenInCloudSync, reconcileListenInOutbox } from "./listenInCloudSync";
import { createListenInEngine, getListenInEngine, resetListenInEnginesForTests } from "./listenInEngine";
import {
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  MEETING_DELETE_CONFIRM,
  createChunk,
  createSession,
  meetingIsCompleted,
  meetingListEntries,
  transcriptText,
} from "./listenInModel";
import { LISTEN_IN_SUMMARY_POLICY } from "./listenInSummaryModel";
import { createListenInMemoryStore } from "./listenInStore";
import { resetMicrophoneOwnershipForTests } from "../microphoneOwnership";

installStructuredCloneShim();

const UID = "alice";
const OTHER = "bob";
const WS = "ws-listen-delete";
const MEETINGS = CLOUD_COLLECTION.LISTEN_IN_MEETINGS;
const TRANSCRIPTS = CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS;
const SUMMARIES = CLOUD_COLLECTION.LISTEN_IN_SUMMARIES;

/* ------------------------------- the fakes ------------------------------- */

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || "audio/webm";
    this.state = "inactive";
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

let minted = 0;
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

const summaryResult = (text) => ({
  summaryText: text,
  keyPoints: ["Boundary walked"],
  decisions: ["Drainage agreed"],
  actionItems: [],
  risks: [],
  followUps: [],
});

/* ------------------------------- the rig --------------------------------- */

function workspaceStore() {
  const store = createMemoryWorkspaceStore();
  store.setUser(UID);
  store.seed(["workspaces", WS], { id: WS, ownerUid: UID });
  store.seed(["workspaces", WS, "members", UID], { uid: UID, role: "owner" });
  store.seed(["workspaces", WS, "members", OTHER], { uid: OTHER, role: "member" });
  return store;
}

/** One device of `uid`: the bridge, the sync engine and the engine created
 *  through the registry — so the engine writes through the decorated store. */
function rig({ listenInStore = createListenInMemoryStore(), cloud = workspaceStore(), uid = UID } = {}) {
  let clock = 1_700_000_000_000;
  let roll = null;
  let cloudOnline = true;
  let spoken = 0;
  const getUserMedia = jest.fn(async () => ({ getTracks: () => [{ stop: () => {} }] }));
  const bridge = installListenInCloudSync({ uid, workspaceId: WS, approved: true, store: listenInStore, storage: localStorage, now: () => clock });
  const sync = createCloudSync({
    workspaceId: WS,
    store: cloud,
    storage: localStorage,
    payloadProviders: bridge.providers,
    isOnline: () => cloudOnline,
    addOnlineListener: () => () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => clock,
  }).start();
  const engine = getListenInEngine(uid, WS, {
    // Each chunk's words name the chunk, so order and completeness are visible.
    transcribe: async () => `Sentence ${(spoken += 1)}.`,
    summarise: jest.fn(async () => ({ ok: true, result: summaryResult("Drainage agreed.") })),
    summaryPolicy: LISTEN_IN_SUMMARY_POLICY,
    recorderSupported: () => true,
    getUserMedia,
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
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
  const r = {
    engine,
    bridge,
    sync,
    cloud,
    listenInStore,
    getUserMedia,
    setCloudOnline: (value) => {
      cloudOnline = value;
    },
    async speak(times = 1) {
      for (let i = 0; i < times; i++) {
        clock += 30000;
        if (roll) roll();
        await settle();
      }
      await engine.flush();
      await settle();
    },
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
    /** A whole meeting: two recording legs (Stop recording / Start recording), then Complete. */
    async meeting({ summarise = true } = {}) {
      await engine.start({ language: "en" });
      await settle();
      await r.speak(1);
      await engine.pause(); // Stop recording
      await settle();
      await engine.resume(); // Start recording again
      await settle();
      await r.speak(1);
      await engine.pause();
      await settle();
      await engine.complete();
      await r.flushAll();
      if (summarise) {
        await engine.summariseNow();
        await r.flushAll();
      }
      return engine.getSnapshot().session.sessionId;
    },
    stop() {
      sync.stop();
      bridge.uninstall();
    },
  };
  return r;
}

const cloudDoc = (r, collection, id) => r.cloud.get(["workspaces", WS, collection, id]);
const ids = (snap) => snap.meetings.map((m) => m.sessionId);

async function everythingOf(r, id) {
  return {
    header: await r.listenInStore.getSession(UID, WS, id),
    chunks: await r.listenInStore.listChunks(UID, WS, id),
    summary: await r.listenInStore.getSummary(UID, WS, id),
    syncStates: await r.listenInStore.listSyncStates(UID, WS, id),
    cloudMeeting: cloudDoc(r, MEETINGS, id),
    cloudPage: cloudDoc(r, TRANSCRIPTS, transcriptPageDocumentId(id, 0)),
    cloudSummary: cloudDoc(r, SUMMARIES, id),
  };
}

function expectAllPresent(all) {
  expect(all.header).toBeTruthy();
  expect(all.chunks.length).toBeGreaterThan(0);
  expect(all.summary).toBeTruthy();
  expect(all.syncStates.length).toBeGreaterThan(0);
  expect(all.cloudMeeting).toBeTruthy();
  expect(all.cloudPage).toBeTruthy();
  expect(all.cloudSummary).toBeTruthy();
}

function expectAllGone(all) {
  expect(all).toEqual({
    header: null,
    chunks: [],
    summary: null,
    syncStates: [],
    cloudMeeting: null,
    cloudPage: null,
    cloudSummary: null,
  });
}

/* ============================== HISTORY ================================== */

describe("1–5. the history lists MEETINGS, one entry per meeting id", () => {
  test("1. a meeting with several recording legs is ONE entry — in the engine, after a reload, and in the account", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const id = await r.meeting();
    expect(ids(r.engine.getSnapshot())).toEqual([id]);
    expect(Object.keys(r.cloud.listWorkspaceDocs(WS, MEETINGS))).toEqual([id]);
    // A reload: a new engine over the same rows lists the same single meeting.
    resetListenInEnginesForTests();
    const again = createListenInEngine({ uid: UID, workspaceId: WS, store: r.listenInStore, summaryEnabled: false, recorderSupported: () => true, addOnlineListener: () => () => {}, addWakeListener: () => () => {} });
    expect(ids(await again.bootstrap())).toEqual([id]);
    r.stop();
  });

  test("2. separate meetings keep separate entries, newest first", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const first = await r.meeting({ summarise: false });
    await r.engine.clear();
    const second = await r.meeting({ summarise: false });
    expect(first).not.toBe(second);
    expect(ids(r.engine.getSnapshot())).toEqual([second, first]);
    r.stop();
  });

  test("3. a duplicate header for one meeting id never doubles its entry", async () => {
    const header = { ...createSession({ sessionId: "s-1", uid: UID, workspaceId: WS, startedAt: 1000, language: "en" }), state: LISTEN_IN_STATE.FINISHED };
    expect(meetingListEntries([header, { ...header, title: "Renamed" }, header]).map((m) => m.sessionId)).toEqual(["s-1"]);
    const store = createListenInMemoryStore();
    await store.putSession(header);
    await store.putSession({ ...header, updatedAt: 2000 });
    const engine = createListenInEngine({ uid: UID, workspaceId: WS, store, summaryEnabled: false, recorderSupported: () => true, addOnlineListener: () => () => {}, addWakeListener: () => () => {} });
    expect(ids(await engine.bootstrap())).toEqual(["s-1"]);
  });

  test("4/5. a multi-leg meeting opens as one ordered transcript, and listing or viewing never touches the microphone", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const id = await r.meeting();
    const atComplete = r.engine.getSnapshot();
    await r.engine.clear();
    const calls = r.getUserMedia.mock.calls.length;
    const snap = await r.engine.view(id);
    expect(snap.session.sessionId).toBe(id);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    // Both legs (each sealing its timed chunk and its Stop chunk), in one
    // unbroken sequence, as the one transcript the meeting had at Complete.
    expect(snap.chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    expect(transcriptText(snap.chunks)).toBe("Sentence 1. Sentence 2. Sentence 3. Sentence 4.");
    expect(transcriptText(snap.chunks)).toBe(transcriptText(atComplete.chunks));
    expect(snap.summary.result.summaryText).toBe("Drainage agreed.");
    expect(snap.active).toBe(false);
    expect(r.getUserMedia.mock.calls.length).toBe(calls);
    r.stop();
  });
});

/* =============================== DELETE ================================== */

describe("8/9. Delete meeting removes the whole meeting, locally and in the account, and nothing else", () => {
  test("the confirmation says what is lost", () => {
    expect(MEETING_DELETE_CONFIRM.startsWith("Delete this meeting?")).toBe(true);
    expect(MEETING_DELETE_CONFIRM).toMatch(/transcript and summary will also be deleted/);
    expect(MEETING_DELETE_CONFIRM).toMatch(/cannot be undone/);
    expect(meetingIsCompleted({ state: LISTEN_IN_STATE.FINISHED })).toBe(true);
    for (const state of [LISTEN_IN_STATE.RECORDING, LISTEN_IN_STATE.PAUSED, LISTEN_IN_STATE.INTERRUPTED, LISTEN_IN_STATE.STOPPING, LISTEN_IN_STATE.FINISHING, LISTEN_IN_STATE.IDLE]) {
      expect(meetingIsCompleted({ state })).toBe(false);
    }
  });

  test("8/9. header, chunks, summary, bookkeeping and the three cloud documents go; the other meeting is untouched", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const keep = await r.meeting();
    await r.engine.clear();
    const doomed = await r.meeting();
    await r.engine.clear();
    expectAllPresent(await everythingOf(r, doomed));
    const kept = await everythingOf(r, keep);
    expectAllPresent(kept);

    await r.engine.deleteMeeting(doomed);
    await r.flushAll();
    expectAllGone(await everythingOf(r, doomed));
    expect(ids(r.engine.getSnapshot())).toEqual([keep]);
    expect(r.engine.getSnapshot().error).toBeNull();
    // The other meeting: every row and every cloud document exactly as it was.
    expect(await everythingOf(r, keep)).toEqual(kept);
    r.stop();
  });

  test("deleting the meeting ON SHOW takes it out of the window", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const id = await r.meeting();
    expect(r.engine.getSnapshot().session.sessionId).toBe(id);
    const snap = await r.engine.deleteMeeting(id);
    expect(snap.session).toBeNull();
    expect(snap.chunks).toEqual([]);
    expect(snap.summary).toBeNull();
    expect(snap.meetings).toEqual([]);
    await r.flushAll();
    expectAllGone(await everythingOf(r, id));
    r.stop();
  });

  test("a view already reading the meeting when it is deleted never puts it back on show", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const id = await r.meeting({ summarise: false });
    await r.engine.clear();
    const viewing = r.engine.view(id);
    await r.engine.deleteMeeting(id);
    await viewing;
    expect(r.engine.getSnapshot().session).toBeNull();
    expect((await r.engine.view(id)).session).toBeNull();
    r.stop();
  });

  test("a failed delete keeps the entry and its rows; a retry then deletes it and only it", async () => {
    const base = createListenInMemoryStore();
    for (const id of ["s-1", "s-2"]) {
      await base.putSession({ ...createSession({ sessionId: id, uid: UID, workspaceId: WS, startedAt: id === "s-1" ? 1000 : 2000, language: "en" }), state: LISTEN_IN_STATE.FINISHED });
    }
    let failNext = true;
    const store = Object.freeze({
      ...base,
      deleteSession: async (...args) => {
        if (failNext) {
          failNext = false;
          throw new Error("blocked");
        }
        return base.deleteSession(...args);
      },
    });
    const engine = createListenInEngine({ uid: UID, workspaceId: WS, store, summaryEnabled: false, recorderSupported: () => true, addOnlineListener: () => () => {}, addWakeListener: () => () => {} });
    await engine.bootstrap();
    const failed = await engine.deleteMeeting("s-1");
    expect(ids(failed)).toEqual(["s-2", "s-1"]);
    expect(failed.error.message).toBe(LISTEN_IN_MESSAGE.DELETE_FAILED);
    expect(await base.getSession(UID, WS, "s-1")).not.toBeNull();
    const retried = await engine.deleteMeeting("s-1");
    expect(ids(retried)).toEqual(["s-2"]);
    expect(await base.getSession(UID, WS, "s-1")).toBeNull();
    expect(await base.getSession(UID, WS, "s-2")).not.toBeNull();
  });

  test("a failed local delete removes nothing from the list and says so", async () => {
    const base = createListenInMemoryStore();
    const header = { ...createSession({ sessionId: "s-1", uid: UID, workspaceId: WS, startedAt: 1000, language: "en" }), state: LISTEN_IN_STATE.FINISHED };
    await base.putSession(header);
    const store = Object.freeze({ ...base, deleteSession: async () => { throw new Error("blocked"); } });
    const engine = createListenInEngine({ uid: UID, workspaceId: WS, store, summaryEnabled: false, recorderSupported: () => true, addOnlineListener: () => () => {}, addWakeListener: () => () => {} });
    await engine.bootstrap();
    const snap = await engine.deleteMeeting("s-1");
    expect(ids(snap)).toEqual(["s-1"]);
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.DELETE_FAILED);
    expect(await base.getSession(UID, WS, "s-1")).not.toBeNull();
  });
});

describe("10. creator-only: another account can reach none of it", () => {
  test("another member's engine on the same device cannot delete the creator's meeting, locally or in the account", async () => {
    const shared = createListenInMemoryStore();
    const cloud = workspaceStore();
    const mine = rig({ listenInStore: shared, cloud });
    await mine.engine.bootstrap();
    const id = await mine.meeting();
    await mine.engine.clear();
    const before = await everythingOf(mine, id);
    mine.stop();

    resetListenInEnginesForTests();
    cloud.setUser(OTHER);
    const theirs = rig({ listenInStore: shared, cloud, uid: OTHER });
    const boot = await theirs.engine.bootstrap();
    expect(boot.meetings).toEqual([]); // never listed for them
    await theirs.engine.deleteMeeting(id); // and not reachable by id
    await theirs.flushAll();
    expect(listOutboxEntries(WS, localStorage).filter((e) => e.op === OUTBOX_OP.DELETE)).toEqual([]);
    cloud.setUser(UID);
    expect(await everythingOf(mine, id)).toEqual(before);
    theirs.stop();
  });
});

describe("11. nothing queued can bring a deleted meeting back", () => {
  test("upserts queued while the cloud is unreachable are replaced by the deletes; the reconcile and a reload find nothing", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const id = await r.meeting();
    // Offline: an edit queues upserts of the summary and the header.
    r.setCloudOnline(false);
    await r.engine.editSummaryText("Edited offline.");
    await r.bridge.store.idle();
    await r.sync.flush();
    expect(listOutboxEntries(WS, localStorage).some((e) => e.op === OUTBOX_OP.UPSERT && e.id === id)).toBe(true);

    await r.engine.deleteMeeting(id);
    await r.bridge.store.idle();
    const queued = listOutboxEntries(WS, localStorage).filter((e) => e.id.startsWith(id));
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((e) => e.op === OUTBOX_OP.DELETE)).toBe(true);

    r.setCloudOnline(true);
    await r.flushAll();
    expectAllGone(await everythingOf(r, id));
    expect(outboxSize(WS, localStorage)).toBe(0);
    // The session-start repair re-projects local meetings only — there is none.
    const repair = await reconcileListenInOutbox({ uid: UID, workspaceId: WS, store: r.listenInStore, storage: localStorage });
    expect(repair.enqueued).toEqual([]);
    await r.sync.flush();
    expect(cloudDoc(r, MEETINGS, id)).toBeNull();
    // A reload lists nothing.
    resetListenInEnginesForTests();
    const again = createListenInEngine({ uid: UID, workspaceId: WS, store: r.listenInStore, summaryEnabled: false, recorderSupported: () => true, addOnlineListener: () => () => {}, addWakeListener: () => () => {} });
    expect((await again.bootstrap()).meetings).toEqual([]);
    r.stop();
  });
});

/* ============================== SEMANTICS ================================ */

describe("12. an active or unfinished meeting cannot be deleted from history", () => {
  test("the stopped meeting on show is refused, keeps everything, and stays the active meeting", async () => {
    const r = rig();
    await r.engine.bootstrap();
    await r.engine.start({ language: "en" });
    await settle();
    await r.speak(1);
    await r.engine.pause();
    await r.flushAll();
    const id = r.engine.getSnapshot().session.sessionId;
    const snap = await r.engine.deleteMeeting(id);
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.DELETE_UNFINISHED);
    expect(snap.session.sessionId).toBe(id);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(snap.active).toBe(true);
    expect(ids(snap)).toEqual([id]);
    expect(await r.listenInStore.getSession(UID, WS, id)).not.toBeNull();
    expect(cloudDoc(r, MEETINGS, id)).toBeTruthy();
    expect(listOutboxEntries(WS, localStorage).filter((e) => e.op === OUTBOX_OP.DELETE)).toEqual([]);
    r.stop();
  });

  test("a stored unfinished header that is not on show is refused too", async () => {
    const store = createListenInMemoryStore();
    for (const state of [LISTEN_IN_STATE.INTERRUPTED, LISTEN_IN_STATE.RECORDING, LISTEN_IN_STATE.FINISHING]) {
      await store.putSession({ ...createSession({ sessionId: `s-${state}`, uid: UID, workspaceId: WS, startedAt: 1000, language: "en" }), state });
    }
    // Not bootstrapped, so none of them is the engine's session.
    const engine = createListenInEngine({ uid: UID, workspaceId: WS, store, summaryEnabled: false, recorderSupported: () => true, addOnlineListener: () => () => {}, addWakeListener: () => () => {} });
    for (const state of [LISTEN_IN_STATE.INTERRUPTED, LISTEN_IN_STATE.RECORDING, LISTEN_IN_STATE.FINISHING]) {
      const snap = await engine.deleteMeeting(`s-${state}`);
      expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.DELETE_UNFINISHED);
      expect(await store.getSession(UID, WS, `s-${state}`)).not.toBeNull();
    }
  });

  test("deleting a completed meeting while another is RECORDING leaves the live meeting exactly as it is", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const old = await r.meeting({ summarise: false });
    await r.engine.clear();
    await r.engine.start({ language: "en" });
    await settle();
    await r.speak(1);
    const live = r.engine.getSnapshot();
    const calls = r.getUserMedia.mock.calls.length;
    const snap = await r.engine.deleteMeeting(old);
    expect(snap.session).toEqual(live.session);
    expect(snap.chunks).toEqual(live.chunks);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(ids(snap)).toEqual([live.session.sessionId]);
    expect(r.getUserMedia.mock.calls.length).toBe(calls);
    await r.flushAll();
    expect(await r.listenInStore.getSession(UID, WS, old)).toBeNull();
    expect(cloudDoc(r, MEETINGS, live.session.sessionId)).toBeTruthy();
    r.stop();
  });
});

describe("13. Clear stays non-destructive; Discard stays the unfinished meeting's delete", () => {
  test("Clear removes nothing anywhere and queues no delete", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const id = await r.meeting();
    const before = await everythingOf(r, id);
    await r.engine.clear();
    await r.flushAll();
    expect(r.engine.getSnapshot().session).toBeNull();
    expect(ids(r.engine.getSnapshot())).toEqual([id]);
    expect(await everythingOf(r, id)).toEqual(before);
    expect(listOutboxEntries(WS, localStorage).filter((e) => e.op === OUTBOX_OP.DELETE)).toEqual([]);
    r.stop();
  });

  test("Discard still throws away the unfinished meeting on show", async () => {
    const r = rig();
    await r.engine.bootstrap();
    await r.engine.start({ language: "en" });
    await settle();
    await r.speak(1);
    await r.engine.pause();
    await r.flushAll();
    const id = r.engine.getSnapshot().session.sessionId;
    await r.engine.discard();
    await r.flushAll();
    expect(r.engine.getSnapshot().meetings).toEqual([]);
    expect(await r.listenInStore.getSession(UID, WS, id)).toBeNull();
    expect(cloudDoc(r, MEETINGS, id)).toBeNull();
    r.stop();
  });
});

/* ====== SELECTING A SAVED MEETING NEVER DISPLACES AN UNFINISHED ONE ======== */
//
// Both history surfaces (the desktop CAPTURE list and the phone drawer) open a
// saved meeting through `engine.view`. Its guard is `isSessionOpen(session)`:
// every state except finished/idle — recording, stopped (paused), interrupted,
// stopping and completing (finishing) — refuses with MEETING_ACTIVE and
// touches nothing. The UI's disabled row is a courtesy in front of this.

function seededEngine(store) {
  return createListenInEngine({
    uid: UID,
    workspaceId: WS,
    store,
    // A transcription that never returns, so a COMPLETING meeting with audio
    // still to transcribe stays completing for the whole test.
    transcribe: () => new Promise(() => {}),
    summaryEnabled: false,
    recorderSupported: () => true,
    getUserMedia: jest.fn(async () => {
      throw new Error("no microphone in this test");
    }),
    addOnlineListener: () => () => {},
    addWakeListener: () => () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
}

describe("view cannot replace, interrupt, discard or overwrite an unfinished meeting", () => {
  test("RECORDING (live microphone): viewing a saved meeting is refused and the recording carries on", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const old = await r.meeting({ summarise: false });
    await r.engine.clear();
    await r.engine.start({ language: "en" });
    await settle();
    await r.speak(1);
    const before = r.engine.getSnapshot();
    expect(before.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    const mic = r.getUserMedia.mock.calls.length;
    const storedBefore = await r.listenInStore.getSession(UID, WS, before.session.sessionId);

    const snap = await r.engine.view(old);
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.MEETING_ACTIVE);
    expect(snap.session.sessionId).toBe(before.session.sessionId);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap.chunks).toEqual(before.chunks);
    expect(snap.active).toBe(true);
    expect(r.getUserMedia.mock.calls.length).toBe(mic);
    expect(await r.listenInStore.getSession(UID, WS, before.session.sessionId)).toEqual(storedBefore);
    // Nothing of either meeting was deleted, and the recording is still live.
    expect(await r.listenInStore.getSession(UID, WS, old)).not.toBeNull();
    await r.speak(1);
    expect(r.engine.getSnapshot().chunks.length).toBeGreaterThan(before.chunks.length);
    r.stop();
  });

  test("STOPPED, then repeated attempts: the meeting stays the active one with all its chunks", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const old = await r.meeting({ summarise: false });
    await r.engine.clear();
    await r.engine.start({ language: "en" });
    await settle();
    await r.speak(1);
    await r.engine.pause();
    await r.flushAll();
    const before = r.engine.getSnapshot();
    expect(before.session.state).toBe(LISTEN_IN_STATE.PAUSED);
    for (let i = 0; i < 3; i += 1) {
      const snap = await r.engine.view(old);
      expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.MEETING_ACTIVE);
      expect(snap.session).toEqual(before.session);
      expect(snap.chunks).toEqual(before.chunks);
    }
    // It can still be resumed and completed — nothing about it was disturbed.
    await r.engine.resume();
    await settle();
    expect(r.engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    r.stop();
  });

  test.each([
    [LISTEN_IN_STATE.INTERRUPTED],
    [LISTEN_IN_STATE.FINISHING],
  ])("%s (recovered at start): viewing a saved meeting is refused; the unfinished one stays on show, unwritten", async (state) => {
    const base = createListenInMemoryStore();
    const mk = (sessionId, startedAt, st) => ({
      ...createSession({ sessionId, uid: UID, workspaceId: WS, startedAt, language: "en" }),
      state: st,
      legStartedAt: null,
    });
    await base.putSession(mk("s-saved", 1000, LISTEN_IN_STATE.FINISHED));
    await base.putSession(mk("s-unfinished", 2000, state));
    // Audio still waiting to be transcribed — a completing meeting with
    // nothing left to do would (correctly) finish itself at startup.
    await base.putChunk(
      createChunk({ uid: UID, workspaceId: WS, sessionId: "s-unfinished", seq: 0, mimeType: "audio/webm", byteLength: 16, startedAt: 2000, endedAt: 32000, language: "en" }),
      new Blob([new Uint8Array(16)], { type: "audio/webm" })
    );
    const writes = [];
    const recorded = (name) => (...args) => {
      writes.push(name);
      return base[name](...args);
    };
    const store = Object.freeze({
      ...base,
      putSession: recorded("putSession"),
      deleteSession: recorded("deleteSession"),
      patchChunk: recorded("patchChunk"),
    });
    const engine = seededEngine(store);
    const boot = await engine.bootstrap();
    expect(boot.session.sessionId).toBe("s-unfinished");
    expect(boot.active).toBe(true);
    writes.length = 0;
    const snap = await engine.view("s-saved");
    expect(snap.error.message).toBe(LISTEN_IN_MESSAGE.MEETING_ACTIVE);
    expect(snap.session.sessionId).toBe("s-unfinished");
    expect(snap.session.state).toBe(boot.session.state);
    // The view wrote no header and deleted nothing (the completing meeting's
    // own drain may still be marking its chunk, which is not the view's).
    expect(writes.filter((w) => w !== "patchChunk")).toEqual([]);
    expect(await base.getSession(UID, WS, "s-unfinished")).not.toBeNull();
    expect(await base.getSession(UID, WS, "s-saved")).not.toBeNull();
  });

  test("a view that was already reading a saved meeting loses to a meeting that starts meanwhile", async () => {
    const r = rig();
    await r.engine.bootstrap();
    const old = await r.meeting({ summarise: false });
    await r.engine.clear();
    const viewing = r.engine.view(old);
    await r.engine.start({ language: "en" });
    await viewing;
    const snap = r.engine.getSnapshot();
    expect(snap.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(snap.session.sessionId).not.toBe(old);
    r.stop();
  });
});
