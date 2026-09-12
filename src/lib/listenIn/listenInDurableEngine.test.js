// src/lib/listenIn/listenInDurableEngine.test.js
//
// THE ENGINE OVER REAL INDEXEDDB (Phase 8D.1, durable capture approved
// 2026-09-12).
//
// `listenInEngine.test.js` drives the engine over the memory store, because
// that isolates the engine's own logic. `listenInStore.test.js` drives the
// durable store over a real database, because that isolates the store's. This
// file is the join: the ACTUAL production path, engine and IndexedDB together,
// with nothing standing in for the database.
//
// It exists because activating the policy made this the path the product
// takes, and two suites that each pass in isolation do not prove the pair
// works — a key path the engine builds one way and the store reads another
// would slip straight through both.
//
// What it proves end to end: a capture is written as it happens; its audio is
// released as each transcript lands and RETAINED when one fails; a brand-new
// engine over a brand-new store connection recovers the session, its chunks
// and their order; and one account's records are unreachable from another's.
import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "buffer";
import { createListenInEngine } from "./listenInEngine";
import { createListenInDurableStore } from "./listenInStore";
import { CHUNK_STATE, LISTEN_IN_STATE, transcriptText } from "./listenInModel";
import { deleteAssetDb, installStructuredCloneShim } from "../assetDbTestHarness";
import { resetMicrophoneOwnershipForTests } from "../microphoneOwnership";

installStructuredCloneShim();

class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || "";
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
    // fake-indexeddb stores what it is given, and a Node Blob is what it can
    // structured-clone — the same surface a browser Blob presents here.
    if (this.ondataavailable) {
      this.ondataavailable({ data: new NodeBlob(["AUDIO"], { type: this.mimeType }) });
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

const WS = "ws-durable";
const UID = "uid-durable";
const CHUNK_MS = 30000;

let clock;
let intervals;
let timeouts;
let nextTimerId;
let transcribe;
let tracks;

function harnessTimers() {
  clock = 1_700_000_000_000;
  intervals = new Map();
  timeouts = new Map();
  nextTimerId = 1;
}

const now = () => clock;
const advance = (ms) => {
  clock += ms;
};
const tickRoll = () => {
  for (const { fn } of [...intervals.values()]) fn();
};
const tickRetry = () => {
  const due = [...timeouts.values()];
  timeouts.clear();
  for (const { fn } of due) fn();
};

/** Let the engine's real promise chain finish against a real database. */
const settle = async () => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function makeEngine(uid = UID) {
  return createListenInEngine({
    uid,
    workspaceId: WS,
    // THE REAL STORE. Nothing here stands in for IndexedDB.
    store: createListenInDurableStore(),
    transcribe: (...args) => transcribe(...args),
    getUserMedia: async () => {
      tracks = [{ stop: jest.fn() }];
      return { getTracks: () => tracks };
    },
    recorderSupported: () => true,
    chunkMs: CHUNK_MS,
    now,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timeouts.delete(id),
    setInterval_: (fn, ms) => {
      const id = nextTimerId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval_: (id) => intervals.delete(id),
    newSessionId: () => `${uid}-session`,
  });
}

beforeEach(async () => {
  await deleteAssetDb();
  resetMicrophoneOwnershipForTests();
  FakeMediaRecorder.instances = [];
  harnessTimers();
  transcribe = jest.fn(async () => "spoken words");
});

/* ========================================================================= */

describe("a capture is written to IndexedDB as it happens", () => {
  test("chunks land in the database, in order, with their audio", async () => {
    const engine = makeEngine();
    await engine.start({ language: "en" });
    for (let i = 0; i < 3; i += 1) {
      advance(CHUNK_MS);
      tickRoll();
      await settle();
    }

    // Read through a SEPARATE store connection — what is actually on disk.
    const disk = createListenInDurableStore();
    const header = await disk.getSession(UID, WS, `${UID}-session`);
    expect(header.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(header.language).toBe("en");
    expect(header.nextSeq).toBe(3);
    const rows = await disk.listChunks(UID, WS, `${UID}-session`);
    expect(rows.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(rows.every((c) => c.state === CHUNK_STATE.TRANSCRIBED)).toBe(true);
    expect(transcriptText(rows)).toBe("spoken words spoken words spoken words");
  });

  test("audio is released from the database once its transcript is stored", async () => {
    const engine = makeEngine();
    await engine.start();
    advance(CHUNK_MS);
    tickRoll();
    await settle();
    const disk = createListenInDurableStore();
    expect(await disk.getChunkAudio(UID, WS, `${UID}-session`, 0)).toBeNull();
    expect((await disk.listChunks(UID, WS, `${UID}-session`))[0].text).toBe("spoken words");
  });

  test("a failed chunk keeps its audio ON DISK, so a later retry is a real retry", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const engine = makeEngine();
    await engine.start();
    advance(CHUNK_MS);
    tickRoll();
    await settle();

    const disk = createListenInDurableStore();
    const before = await disk.listChunks(UID, WS, `${UID}-session`);
    expect(before[0].state).toBe(CHUNK_STATE.FAILED);
    expect(before[0].byteLength).toBeGreaterThan(0);
    // The bytes are still there. Their CONTENT is asserted in
    // listenInStore.test.js, which writes a Node Blob directly; here the
    // engine builds a jsdom Blob, which the structuredClone shim used by
    // fake-indexeddb cannot reconstruct with its prototype intact. That is a
    // test-environment limit, not a product one — so retention is proved the
    // way it actually matters, by the retry below succeeding from disk.
    expect(await disk.getChunkAudio(UID, WS, `${UID}-session`, 0)).toBeTruthy();

    transcribe.mockResolvedValue("recovered from disk");
    advance(200_000);
    tickRetry();
    await settle();
    expect((await disk.listChunks(UID, WS, `${UID}-session`))[0].text).toBe("recovered from disk");
    expect(await disk.getChunkAudio(UID, WS, `${UID}-session`, 0)).toBeNull();
  });
});

describe("a reload really does recover the meeting", () => {
  test("a new engine over a new connection finds the session, its chunks and their order", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const first = makeEngine();
    await first.start({ language: "fr" });
    for (let i = 0; i < 2; i += 1) {
      advance(CHUNK_MS);
      tickRoll();
      await settle();
    }
    // The tab dies: no stop, no shutdown, nothing tidy. Only the database
    // survives — which is the entire point of the durable policy.
    resetMicrophoneOwnershipForTests();

    transcribe.mockResolvedValue("transcribed after the reload");
    const second = makeEngine();
    await second.bootstrap();
    await settle();

    const snap = second.getSnapshot();
    expect(snap.session.sessionId).toBe(`${UID}-session`);
    expect(snap.session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(snap.session.language).toBe("fr");
    expect(snap.chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(second.survivesReload).toBe(true);

    // The retained audio is retried from disk, with no user action.
    advance(200_000);
    tickRetry();
    await settle();
    expect(transcriptText(second.getSnapshot().chunks)).toBe(
      "transcribed after the reload transcribed after the reload"
    );
  });

  test("Resume continues the same session and the next sequence, across the reload", async () => {
    const first = makeEngine();
    await first.start();
    advance(CHUNK_MS);
    tickRoll();
    await settle();
    resetMicrophoneOwnershipForTests();

    const second = makeEngine();
    await second.bootstrap();
    await settle();
    await second.resume();
    await settle();
    advance(CHUNK_MS);
    tickRoll();
    await settle();

    const disk = createListenInDurableStore();
    expect((await disk.listChunks(UID, WS, `${UID}-session`)).map((c) => c.seq)).toEqual([0, 1]);
  });

  test("discarding really removes the header, the chunks and the bytes from disk", async () => {
    transcribe.mockRejectedValue(new Error("Network error"));
    const engine = makeEngine();
    await engine.start();
    advance(CHUNK_MS);
    tickRoll();
    await settle();
    await engine.discard();
    await settle();

    const disk = createListenInDurableStore();
    expect(await disk.getSession(UID, WS, `${UID}-session`)).toBeNull();
    expect(await disk.listChunks(UID, WS, `${UID}-session`)).toHaveLength(0);
    expect(await disk.getChunkAudio(UID, WS, `${UID}-session`, 0)).toBeNull();
  });
});

describe("the account boundary holds against the real database", () => {
  test("account B in the SAME workspace recovers nothing of account A's", async () => {
    const a = makeEngine(UID);
    await a.start({ language: "en" });
    advance(CHUNK_MS);
    tickRoll();
    await settle();
    a.shutdown();
    resetMicrophoneOwnershipForTests();

    const b = makeEngine("uid-other");
    await b.bootstrap();
    await settle();
    expect(b.getSnapshot().session).toBeNull();
    expect(b.getSnapshot().chunks).toHaveLength(0);

    // A's rows are still on disk, under A's own uid.
    const disk = createListenInDurableStore();
    expect(await disk.getSession(UID, WS, `${UID}-session`)).not.toBeNull();
    expect(await disk.listSessions("uid-other", WS)).toHaveLength(0);
    // A signing back in still finds the work.
    const a2 = makeEngine(UID);
    await a2.bootstrap();
    await settle();
    expect(a2.getSnapshot().session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
  });
});
