// src/lib/listenIn/listenInStore.test.js
//
// WHERE A LISTEN IN SESSION LIVES (Phase 8D.1) — the same contract, proved
// against BOTH implementations over a real IndexedDB (fake-indexeddb is the
// project's existing test database, as for every asset-layer suite).
//
// Running one suite over both is the point: the engine above them is written
// once, so if the memory store quietly behaved differently the durable tests
// would be proving something the product never runs, or vice versa. The one
// difference either may declare is `survivesReload`, and that is asserted.
//
// It also pins the two invariants that are not obvious from the interface:
// a listing NEVER carries audio (an hour of speech must not be pulled into
// memory to render a sentence), and a key cannot be formed without naming the
// workspace that owns it.
import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "buffer";
import { createListenInDurableStore, createListenInMemoryStore } from "./listenInStore";
import { createChunk, createSession, CHUNK_STATE } from "./listenInModel";
// The project's existing IndexedDB test harness — one structuredClone shim and
// one database teardown, shared rather than copied (src/lib/assetDbTestHarness.js).
import { deleteAssetDb, installStructuredCloneShim } from "../assetDbTestHarness";

installStructuredCloneShim();

const WS = "ws-a";
const OTHER = "ws-b";
const UID = "uid-a";
const OTHER_UID = "uid-b";

const blob = (text) => new NodeBlob([text], { type: "audio/webm" });

function session(overrides = {}) {
  return createSession({
    sessionId: "s-1",
    uid: UID,
    workspaceId: WS,
    startedAt: 1000,
    language: "en",
    ...overrides,
  });
}

function chunk(seq, overrides = {}) {
  return createChunk({
    uid: UID,
    workspaceId: WS,
    sessionId: "s-1",
    seq,
    mimeType: "audio/webm",
    byteLength: 8,
    startedAt: 1000 + seq * 30000,
    endedAt: 1000 + (seq + 1) * 30000,
    language: "en",
    ...overrides,
  });
}

describe.each([
  ["memory", () => createListenInMemoryStore(), false],
  ["durable (IndexedDB)", () => createListenInDurableStore(), true],
])("%s store", (_name, make, survives) => {
  let store;
  beforeEach(async () => {
    await deleteAssetDb();
    store = make();
  });

  test("it declares honestly whether what it holds survives a reload", () => {
    expect(store.survivesReload).toBe(survives);
  });

  test("a session header round-trips, and is listed for its own workspace only", async () => {
    await store.putSession(session());
    await store.putSession(session({ sessionId: "s-2", workspaceId: OTHER }));
    const read = await store.getSession(UID, WS, "s-1");
    expect(read.sessionId).toBe("s-1");
    expect(read.language).toBe("en");
    expect(read.state).toBe("recording");
    const mine = await store.listSessions(UID, WS);
    expect(mine.map((s) => s.sessionId)).toEqual(["s-1"]);
    expect((await store.listSessions(UID, OTHER)).map((s) => s.sessionId)).toEqual(["s-2"]);
    expect(await store.getSession(UID, WS, "s-2")).toBeNull();
  });

  test("a chunk keeps its audio, and the audio comes back only when asked for by seq", async () => {
    await store.putChunk(chunk(0), blob("AUDIO0"));
    const audio = await store.getChunkAudio(UID, WS, "s-1", 0);
    expect(audio).toBeTruthy();
    expect(typeof audio.text).toBe("function");
    expect(await audio.text()).toBe("AUDIO0");
    expect(await store.getChunkAudio(UID, WS, "s-1", 99)).toBeNull();
  });

  test("A LISTING NEVER CARRIES AUDIO — only metadata and text", async () => {
    await store.putChunk(chunk(0), blob("AUDIO0"));
    await store.putChunk(chunk(1), blob("AUDIO1"));
    const rows = await store.listChunks(UID, WS, "s-1");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty("audio");
      expect(row.state).toBe(CHUNK_STATE.SEALED);
    }
    // …and the bytes are still there for the drain.
    expect(await store.getChunkAudio(UID, WS, "s-1", 0)).toBeTruthy();
  });

  test("chunks come back in sequence order however they were written", async () => {
    for (const seq of [2, 0, 10, 1]) await store.putChunk(chunk(seq), blob(`A${seq}`));
    expect((await store.listChunks(UID, WS, "s-1")).map((c) => c.seq)).toEqual([0, 1, 2, 10]);
  });

  test("patching a chunk changes only the named fields and keeps the audio", async () => {
    await store.putChunk(chunk(0), blob("AUDIO0"));
    const updated = await store.patchChunk(UID, WS, "s-1", 0, {
      state: CHUNK_STATE.TRANSCRIBED,
      text: "hello there",
    });
    expect(updated.state).toBe(CHUNK_STATE.TRANSCRIBED);
    expect(updated.text).toBe("hello there");
    expect(updated.seq).toBe(0);
    expect(updated).not.toHaveProperty("audio");
    expect(await store.getChunkAudio(UID, WS, "s-1", 0)).toBeTruthy();
  });

  test("releasing the audio drops the bytes and keeps the row and its text", async () => {
    await store.putChunk(chunk(0), blob("AUDIO0"));
    await store.patchChunk(UID, WS, "s-1", 0, { state: CHUNK_STATE.TRANSCRIBED, text: "kept" });
    await store.releaseChunkAudio(UID, WS, "s-1", 0);
    expect(await store.getChunkAudio(UID, WS, "s-1", 0)).toBeNull();
    const rows = await store.listChunks(UID, WS, "s-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("kept");
    expect(rows[0].state).toBe(CHUNK_STATE.TRANSCRIBED);
  });

  test("patching a chunk that is not there changes nothing and does not throw", async () => {
    await expect(store.patchChunk(UID, WS, "s-1", 7, { text: "nope" })).resolves.toBeFalsy();
    expect(await store.listChunks(UID, WS, "s-1")).toHaveLength(0);
  });

  test("deleting a session removes its header, its chunks and its retained audio", async () => {
    await store.putSession(session());
    await store.putChunk(chunk(0), blob("AUDIO0"));
    await store.putChunk(chunk(1), blob("AUDIO1"));
    await store.putSession(session({ sessionId: "s-keep" }));
    await store.putChunk(chunk(0, { sessionId: "s-keep" }), blob("KEEP"));

    await store.deleteSession(UID, WS, "s-1");
    expect(await store.getSession(UID, WS, "s-1")).toBeNull();
    expect(await store.listChunks(UID, WS, "s-1")).toHaveLength(0);
    expect(await store.getChunkAudio(UID, WS, "s-1", 0)).toBeNull();
    // The other session of the same workspace is untouched.
    expect(await store.getSession(UID, WS, "s-keep")).not.toBeNull();
    expect(await store.listChunks(UID, WS, "s-keep")).toHaveLength(1);
  });

  test("one workspace cannot read or delete another's session", async () => {
    await store.putSession(session());
    await store.putChunk(chunk(0), blob("AUDIO0"));
    expect(await store.getSession(UID, OTHER, "s-1")).toBeNull();
    expect(await store.listChunks(UID, OTHER, "s-1")).toHaveLength(0);
    expect(await store.getChunkAudio(UID, OTHER, "s-1", 0)).toBeNull();
    await store.deleteSession(UID, OTHER, "s-1");
    // …and the real owner's data is still intact.
    expect(await store.getSession(UID, WS, "s-1")).not.toBeNull();
    expect(await store.listChunks(UID, WS, "s-1")).toHaveLength(1);
  });

  test("an operation that does not name an ACCOUNT is refused, never served broadly", async () => {
    // The uid is checked first and is never optional: there is no call shape
    // that reads, changes or deletes "whatever this browser happens to hold".
    await expect(store.getSession("", WS, "s-1")).rejects.toThrow(/signed-in user/i);
    await expect(store.getSession(null, WS, "s-1")).rejects.toThrow(/signed-in user/i);
    await expect(store.listSessions(undefined, WS)).rejects.toThrow(/signed-in user/i);
    await expect(store.listChunks(null, WS, "s-1")).rejects.toThrow(/signed-in user/i);
    await expect(store.getChunkAudio("", WS, "s-1", 0)).rejects.toThrow(/signed-in user/i);
    await expect(store.patchChunk(null, WS, "s-1", 0, {})).rejects.toThrow(/signed-in user/i);
    await expect(store.releaseChunkAudio("", WS, "s-1", 0)).rejects.toThrow(/signed-in user/i);
    await expect(store.deleteSession(null, WS, "s-1")).rejects.toThrow(/signed-in user/i);
    await expect(store.putSession({ ...session(), uid: "" })).rejects.toThrow(/signed-in user/i);
    await expect(store.putChunk({ ...chunk(0), uid: null })).rejects.toThrow(/signed-in user/i);
  });

  test("an operation that does not name a workspace or a session is refused too", async () => {
    await expect(store.getSession(UID, "", "s-1")).rejects.toThrow(/workspace/i);
    await expect(store.listChunks(UID, null, "s-1")).rejects.toThrow(/workspace/i);
    await expect(store.listSessions(UID, undefined)).rejects.toThrow(/workspace/i);
    await expect(store.getSession(UID, WS, "")).rejects.toThrow(/session id/i);
  });

  /* ------------------- the account boundary, behaviourally ---------------- */

  test("two accounts in the SAME workspace cannot see each other's sessions", async () => {
    await store.putSession(session());
    await store.putChunk(chunk(0), blob("A-AUDIO"));
    await store.patchChunk(UID, WS, "s-1", 0, { state: CHUNK_STATE.TRANSCRIBED, text: "A spoke" });
    // The other account records in the SAME workspace, with the SAME session id.
    await store.putSession(session({ uid: OTHER_UID }));
    await store.putChunk(chunk(0, { uid: OTHER_UID }), blob("B-AUDIO"));
    await store.patchChunk(OTHER_UID, WS, "s-1", 0, {
      state: CHUNK_STATE.TRANSCRIBED,
      text: "B spoke",
    });

    // Neither listing reaches the other, even sharing the workspace and id.
    expect((await store.listSessions(UID, WS)).map((s) => s.uid)).toEqual([UID]);
    expect((await store.listSessions(OTHER_UID, WS)).map((s) => s.uid)).toEqual([OTHER_UID]);
    expect((await store.listChunks(UID, WS, "s-1"))[0].text).toBe("A spoke");
    expect((await store.listChunks(OTHER_UID, WS, "s-1"))[0].text).toBe("B spoke");
    expect(await (await store.getChunkAudio(UID, WS, "s-1", 0)).text()).toBe("A-AUDIO");
    expect(await (await store.getChunkAudio(OTHER_UID, WS, "s-1", 0)).text()).toBe("B-AUDIO");
  });

  test("one account cannot patch, release or delete the other's identically-named session", async () => {
    await store.putSession(session());
    await store.putChunk(chunk(0), blob("A-AUDIO"));
    await store.putSession(session({ uid: OTHER_UID }));
    await store.putChunk(chunk(0, { uid: OTHER_UID }), blob("B-AUDIO"));

    // B writes over what it believes is "session s-1, chunk 0".
    await store.patchChunk(OTHER_UID, WS, "s-1", 0, { text: "B overwrote" });
    await store.releaseChunkAudio(OTHER_UID, WS, "s-1", 0);
    await store.deleteSession(OTHER_UID, WS, "s-1");

    // A's session, chunk, text and audio are all untouched.
    expect(await store.getSession(UID, WS, "s-1")).not.toBeNull();
    const rows = await store.listChunks(UID, WS, "s-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].text).not.toBe("B overwrote");
    expect(await (await store.getChunkAudio(UID, WS, "s-1", 0)).text()).toBe("A-AUDIO");
    // …and B's own session really was deleted, so the delete did work.
    expect(await store.getSession(OTHER_UID, WS, "s-1")).toBeNull();
  });
});

/* ---------------------- what only the durable one does ------------------- */

describe("the durable store actually survives a new connection", () => {
  beforeEach(async () => {
    await deleteAssetDb();
  });

  test("a session written by one store instance is read by a fresh one", async () => {
    const first = createListenInDurableStore();
    await first.putSession(session());
    await first.putChunk(chunk(0), blob("AUDIO0"));
    await first.patchChunk(UID, WS, "s-1", 0, { state: CHUNK_STATE.TRANSCRIBED, text: "persisted" });

    // A different store object entirely — what a reload produces.
    const second = createListenInDurableStore();
    expect((await second.getSession(UID, WS, "s-1")).sessionId).toBe("s-1");
    const rows = await second.listChunks(UID, WS, "s-1");
    expect(rows[0].text).toBe("persisted");
    expect(await (await second.getChunkAudio(UID, WS, "s-1", 0)).text()).toBe("AUDIO0");
  });

  test("the memory store deliberately does NOT — a second instance holds nothing", async () => {
    const first = createListenInMemoryStore();
    await first.putSession(session());
    const second = createListenInMemoryStore();
    expect(await second.getSession(UID, WS, "s-1")).toBeNull();
  });
});
