// src/lib/listenIn/listenInMeetingList.test.js
//
// THE ACCOUNT'S SAVED MEETINGS (2026-10-20) — the list the desktop sidebar's
// CAPTURE group shows under Listen In, and `view`, which opens a completed
// meeting in the SAME Listen In state a meeting is in after Complete.
//
// The real engine over the real memory store (the same contract as the
// IndexedDB store), seeded with headers, chunks and summaries. What is
// proved: the list comes from the existing uid-scoped store and carries
// headers only; listing and viewing write NOTHING; another account's
// meetings are never listed or opened; the active meeting is never displaced
// and a historical one never resumes or records.
import { createListenInEngine, resetListenInEnginesForTests } from "./listenInEngine";
import {
  CHUNK_STATE,
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  createChunk,
  createSession,
  meetingListEntries,
  meetingListLabel,
  meetingListStatus,
  transcriptText,
  upsertMeetingEntry,
  withoutMeetingEntry,
} from "./listenInModel";
import { createSessionSummary } from "./listenInSummaryModel";
import { createListenInMemoryStore } from "./listenInStore";

const UID = "uid-owner";
const OTHER = "uid-other";
const WS = "ws-list";
const T0 = 1_760_000_000_000;
const HOUR = 60 * 60 * 1000;

function header(uid, sessionId, startedAt, state, title = null) {
  return {
    ...createSession({ sessionId, uid, workspaceId: WS, startedAt, language: "en", title }),
    state,
    legStartedAt: null,
  };
}

async function seedMeeting(store, uid, sessionId, startedAt, state, { text = "", title = null, summaryText = null } = {}) {
  await store.putSession(header(uid, sessionId, startedAt, state, title));
  if (text) {
    const chunk = createChunk({
      uid,
      workspaceId: WS,
      sessionId,
      seq: 0,
      mimeType: "audio/webm",
      byteLength: 10,
      startedAt,
      endedAt: startedAt + 30000,
      language: "en",
    });
    await store.putChunk({ ...chunk, state: CHUNK_STATE.TRANSCRIBED, text }, null);
  }
  if (summaryText) {
    const summary = createSessionSummary({ uid, workspaceId: WS, sessionId, now: startedAt });
    await store.putSummary({ ...summary, userSummaryText: summaryText });
  }
}

/** Every write the store receives, so "writes nothing" is a fact, not a hope. */
function spyOnWrites(store) {
  const writes = [];
  const spied = { ...store };
  for (const name of ["putSession", "putChunk", "patchChunk", "putSummary", "putSyncState", "deleteSession", "releaseChunkAudio"]) {
    if (typeof store[name] !== "function") continue;
    spied[name] = (...args) => {
      writes.push(name);
      return store[name](...args);
    };
  }
  return { store: Object.freeze(spied), writes };
}

function engineOver(store) {
  return createListenInEngine({
    uid: UID,
    workspaceId: WS,
    store,
    summaryEnabled: false,
    recorderSupported: () => true,
    getUserMedia: jest.fn(async () => {
      throw new Error("no microphone in this test");
    }),
    addOnlineListener: () => () => {},
    addWakeListener: () => () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => T0 + 10 * HOUR,
  });
}

beforeEach(() => resetListenInEnginesForTests());
afterEach(() => resetListenInEnginesForTests());

describe("the pure list helpers", () => {
  test("entries are header-only, newest first; labels drop the default prefix; only unfinished meetings carry a word", () => {
    const list = meetingListEntries([
      header(UID, "s-old", T0, LISTEN_IN_STATE.FINISHED, "Site meeting"),
      header(UID, "s-new", T0 + HOUR, LISTEN_IN_STATE.PAUSED),
    ]);
    expect(list.map((m) => m.sessionId)).toEqual(["s-new", "s-old"]);
    expect(Object.keys(list[0]).sort()).toEqual(["sessionId", "startedAt", "state", "title"]);
    expect(meetingListLabel(list[1])).toBe("Site meeting");
    expect(list[0].title.startsWith("Listen In — ")).toBe(true);
    expect(meetingListLabel(list[0])).toBe(list[0].title.slice("Listen In — ".length));
    expect(meetingListStatus(list[0])).toBe("Stopped");
    expect(meetingListStatus(list[1])).toBe("");
    expect(meetingListStatus({ state: LISTEN_IN_STATE.RECORDING })).toBe("Recording");
    expect(meetingListStatus({ state: LISTEN_IN_STATE.INTERRUPTED })).toBe("Interrupted");
    expect(meetingListStatus({ state: LISTEN_IN_STATE.FINISHING })).toBe("Completing");
    const upserted = upsertMeetingEntry(list, { ...header(UID, "s-old", T0, LISTEN_IN_STATE.FINISHED), title: "Renamed" });
    expect(upserted.find((m) => m.sessionId === "s-old").title).toBe("Renamed");
    expect(upserted).toHaveLength(2);
    expect(withoutMeetingEntry(list, "s-old").map((m) => m.sessionId)).toEqual(["s-new"]);
  });
});

describe("13/16/17. the list comes from the existing uid-scoped store, without writing", () => {
  test("bootstrap lists this account's meetings newest first — never another account's — and writes nothing", async () => {
    const base = createListenInMemoryStore();
    await seedMeeting(base, UID, "s-1", T0, LISTEN_IN_STATE.FINISHED, { text: "First." });
    await seedMeeting(base, UID, "s-2", T0 + HOUR, LISTEN_IN_STATE.FINISHED, { text: "Second." });
    await seedMeeting(base, OTHER, "s-theirs", T0 + 2 * HOUR, LISTEN_IN_STATE.FINISHED, { text: "Private." });
    const { store, writes } = spyOnWrites(base);
    const engine = engineOver(store);
    const snap = await engine.bootstrap();
    expect(snap.meetings.map((m) => m.sessionId)).toEqual(["s-2", "s-1"]);
    // Headers only: no transcript, no audio, no summary rides on the list.
    for (const m of snap.meetings) expect(Object.keys(m).sort()).toEqual(["sessionId", "startedAt", "state", "title"]);
    expect(snap.session).toBeNull();
    expect(writes).toEqual([]);
  });

  test("a saved header keeps the list current; a discard removes it", async () => {
    const store = createListenInMemoryStore();
    await seedMeeting(store, UID, "s-1", T0, LISTEN_IN_STATE.FINISHED, { text: "First." });
    const engine = engineOver(store);
    await engine.bootstrap();
    await engine.view("s-1");
    await engine.discard();
    expect(engine.getSnapshot().meetings).toEqual([]);
    expect(await store.getSession(UID, WS, "s-1")).toBeNull();
  });
});

describe("14. a completed meeting opens in the existing review state", () => {
  test("view loads its header, transcript and summary — read only, no microphone, no resume", async () => {
    const base = createListenInMemoryStore();
    await seedMeeting(base, UID, "s-1", T0, LISTEN_IN_STATE.FINISHED, {
      text: "We agreed the drainage plan.",
      summaryText: "Drainage agreed.",
    });
    const { store, writes } = spyOnWrites(base);
    const engine = engineOver(store);
    await engine.bootstrap();
    const snap = await engine.view("s-1");
    expect(snap.session.sessionId).toBe("s-1");
    expect(snap.session.state).toBe(LISTEN_IN_STATE.FINISHED);
    expect(snap.active).toBe(false);
    expect(transcriptText(snap.chunks)).toBe("We agreed the drainage plan.");
    expect(snap.summary.userSummaryText).toBe("Drainage agreed.");
    expect(writes).toEqual([]);
    // Clear keeps its meaning: it only takes the meeting off screen.
    await engine.clear();
    expect(engine.getSnapshot().session).toBeNull();
    expect(await base.getSession(UID, WS, "s-1")).not.toBeNull();
  });

  test("another account's meeting cannot be opened, even by id", async () => {
    const store = createListenInMemoryStore();
    await seedMeeting(store, OTHER, "s-theirs", T0, LISTEN_IN_STATE.FINISHED, { text: "Private." });
    const engine = engineOver(store);
    await engine.bootstrap();
    const snap = await engine.view("s-theirs");
    expect(snap.session).toBeNull();
    expect(snap.chunks).toEqual([]);
  });

  test("an unknown id changes nothing", async () => {
    const store = createListenInMemoryStore();
    const engine = engineOver(store);
    await engine.bootstrap();
    expect((await engine.view("s-missing")).session).toBeNull();
  });
});

describe("15. the unfinished meeting is never displaced", () => {
  test("while a meeting is open, viewing another is refused with the existing message", async () => {
    const base = createListenInMemoryStore();
    await seedMeeting(base, UID, "s-done", T0, LISTEN_IN_STATE.FINISHED, { text: "Old." });
    await seedMeeting(base, UID, "s-open", T0 + HOUR, LISTEN_IN_STATE.PAUSED, { text: "Ongoing." });
    const { store, writes } = spyOnWrites(base);
    const engine = engineOver(store);
    const boot = await engine.bootstrap();
    expect(boot.session.sessionId).toBe("s-open");
    expect(boot.active).toBe(true);
    expect(boot.meetings.find((m) => m.sessionId === "s-open").state).toBe(LISTEN_IN_STATE.PAUSED);

    writes.length = 0;
    const snap = await engine.view("s-done");
    expect(snap.session.sessionId).toBe("s-open");
    expect(snap.session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(snap.error && snap.error.message).toBe(LISTEN_IN_MESSAGE.MEETING_ACTIVE);
    expect(writes).toEqual([]);
    // Asking for the active one is simply a no-op.
    expect((await engine.view("s-open")).session.sessionId).toBe("s-open");
  });

  test("a stored header that is still open is never adopted by view", async () => {
    const store = createListenInMemoryStore();
    await seedMeeting(store, UID, "s-int", T0, LISTEN_IN_STATE.INTERRUPTED, { text: "Cut off." });
    const engine = engineOver(store);
    // Not bootstrapped: discovery, not view, owns an unfinished meeting.
    const snap = await engine.view("s-int");
    expect(snap.session).toBeNull();
  });

  test("a late view loses to a later one", async () => {
    const store = createListenInMemoryStore();
    await seedMeeting(store, UID, "s-a", T0, LISTEN_IN_STATE.FINISHED, { text: "A." });
    await seedMeeting(store, UID, "s-b", T0 + HOUR, LISTEN_IN_STATE.FINISHED, { text: "B." });
    const engine = engineOver(store);
    await engine.bootstrap();
    const first = engine.view("s-a");
    const second = engine.view("s-b");
    await Promise.all([first, second]);
    expect(engine.getSnapshot().session.sessionId).toBe("s-b");
  });
});
