// src/lib/listenIn/listenInSecurityInvariants.test.js
//
// THE LISTEN IN SECURITY INVARIANTS, ASSERTED FROM TRACKED CODE ALONE.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// `docs/SECURITY.md` is the governance document for durable Listen In capture
// and the Listen In summary route. It is INTENTIONALLY GITIGNORED
// (`.gitignore` → `docs/`): its wording is approved by a person, in a
// deliberate review step, and it is not part of the repository a build checks
// out. CI therefore CANNOT truthfully require it to exist — and a build that
// fails because an ignored document is missing reports a security regression
// that did not happen, which is worse than not checking at all.
//
// So the split is:
//
//   GOVERNANCE   the document's wording — approved by a human, checked locally
//                only, in listenInPolicy.test.js, and skipped where absent.
//   CI           THIS FILE: the same promises asserted against the TRACKED
//                implementation — the flag, the policy constant, the stores,
//                the engine, the route and the client — so the invariant holds
//                in a clean checkout with no `docs/` directory at all.
//
// Each test below is one promise the approved policy makes. Where the deep
// behavioural proof already lives elsewhere it is named rather than duplicated;
// what is asserted here is the INVARIANT itself, compactly, so that one file
// fails when a security property is lost.
import {
  LISTEN_IN_DURABLE_CAPTURE_APPROVED,
  LISTEN_IN_PERSISTENCE,
  LISTEN_IN_PERSISTENCE_POLICY,
  resolveListenInPersistence,
} from "./listenInPolicy";
import {
  LISTEN_IN_CHUNK_KEY_PATH,
  LISTEN_IN_SESSION_KEY_PATH,
  LISTEN_IN_SUMMARY_KEY_PATH,
} from "../assetDb";
import { createListenInDurableStore, createListenInMemoryStore } from "./listenInStore";
import {
  applyListenInIdentity,
  createListenInEngine,
  getListenInEngine,
  resetListenInEnginesForTests,
} from "./listenInEngine";
import { CHUNK_STATE, LISTEN_IN_STATE } from "./listenInModel";
import {
  MICROPHONE_OWNER,
  currentMicrophoneOwner,
  resetMicrophoneOwnershipForTests,
} from "../microphoneOwnership";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const src = (relative) => fs.readFileSync(path.join(ROOT, "src", relative), "utf8");
/** Comments state intent; only CODE may satisfy an invariant. */
const code = (text) =>
  text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const UID = "uid-invariant";
const WS = "ws-invariant";

/** The smallest recorder that seals a chunk, for the capture-bound tests. */
class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported() {
    return true;
  }
  constructor(stream, options) {
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
      this.ondataavailable({ data: new Blob([new Uint8Array(16)], { type: this.mimeType }) });
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

const settle = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/** A session and one sealed chunk, straight into a store — no microphone. */
async function seedSealedSession(store, { audio = new Blob(["bytes"]) } = {}) {
  await store.putSession({
    schemaVersion: 1,
    uid: UID,
    workspaceId: WS,
    sessionId: "s-seed",
    title: "seeded",
    startedAt: 1000,
    stoppedAt: null,
    capturedMs: 0,
    legStartedAt: null,
    state: LISTEN_IN_STATE.FINISHING,
    stopReason: "user",
    language: "en",
    nextSeq: 1,
    updatedAt: 1000,
  });
  await store.putChunk(
    {
      uid: UID,
      workspaceId: WS,
      sessionId: "s-seed",
      seq: 0,
      mimeType: "audio/webm",
      byteLength: 5,
      startedAt: 1000,
      endedAt: 31000,
      state: CHUNK_STATE.SEALED,
      attempts: 0,
      nextAttemptAt: 0,
      lastCode: null,
      text: "",
      language: "en",
      speaker: null,
      recovered: false,
    },
    audio
  );
}

/* ===================== 1. the approval, in tracked code ================== */

describe("1. durable capture is approved, and the approval is tracked", () => {
  test("the flag is on and the policy beside it is a real, complete statement", () => {
    expect(LISTEN_IN_DURABLE_CAPTURE_APPROVED).toBe(true);
    expect(LISTEN_IN_PERSISTENCE_POLICY.why).toMatch(/reload, a crash, or an hour offline/i);
    // The whole policy travels in tracked source, so this invariant needs no
    // document on disk to be checkable.
    expect(Object.keys(LISTEN_IN_PERSISTENCE_POLICY).length).toBeGreaterThanOrEqual(10);
  });
});

/* ================== 2. Quick Add Dictation stays memory-only ============= */

describe("2. Quick Add Dictation has no durable path at all", () => {
  test("the dictation modules reach no Listen In store, no asset database, no IndexedDB", () => {
    for (const file of ["lib/quickAddDictation.js", "hooks/useDictation.js"]) {
      const source = code(src(file));
      expect({ file, hit: /listenInStore|createListenInDurableStore|assetDbTransaction/.test(source) }).toEqual({
        file,
        hit: false,
      });
      expect({ file, hit: /indexedDB|LISTEN_IN_(SESSION|CHUNK|SUMMARY)_STORE/.test(source) }).toEqual({
        file,
        hit: false,
      });
      // Nor does it write audio anywhere else that outlives the tab.
      expect({ file, hit: /localStorage|sessionStorage/.test(source) }).toEqual({ file, hit: false });
    }
  });

  test("the policy says so in tracked code, so the scope cannot widen silently", () => {
    expect(LISTEN_IN_PERSISTENCE_POLICY.scope).toMatch(/Listen In only/);
    expect(LISTEN_IN_PERSISTENCE_POLICY.scope).toMatch(/Quick Add Dictation stays memory-only/);
  });
});

/* =============== 3. Listen In persistence is IndexedDB only ============== */

describe("3. Listen In persists to IndexedDB, and to nothing else", () => {
  test("the durable store is the asset database; the memory store admits it is not durable", () => {
    expect(createListenInDurableStore().survivesReload).toBe(true);
    expect(createListenInMemoryStore().survivesReload).toBe(false);
    const store = code(src("lib/listenIn/listenInStore.js"));
    expect(store).toMatch(/assetDbTransaction/);
    // No other persistence mechanism is reachable from the store module.
    expect(store).not.toMatch(/localStorage|sessionStorage|fetch\(|fs\./);
  });

  test("approval alone never makes a browser durable — the capability is checked too", () => {
    expect(resolveListenInPersistence({ approved: true, hasIndexedDb: false })).toBe(
      LISTEN_IN_PERSISTENCE.MEMORY
    );
  });
});

/* ================ 4. the identity scope is uid + workspace =============== */

describe("4. every stored record is scoped to the account AND the workspace", () => {
  test("all three key paths begin with the uid and name the workspace", () => {
    expect(LISTEN_IN_SESSION_KEY_PATH).toEqual(["uid", "workspaceId", "sessionId"]);
    expect(LISTEN_IN_CHUNK_KEY_PATH).toEqual(["uid", "workspaceId", "sessionId", "seq"]);
    // The 8D.2 summary store is scoped identically — a summary is derived from
    // a meeting and is no less private than the meeting.
    expect(LISTEN_IN_SUMMARY_KEY_PATH).toEqual(["uid", "workspaceId", "sessionId"]);
  });

  test("a call that does not name an account is REFUSED, not widened", async () => {
    for (const store of [createListenInMemoryStore(), createListenInDurableStore()]) {
      await expect(store.listSessions("", WS)).rejects.toThrow(/signed-in user is required/i);
      await expect(store.listSessions(UID, "")).rejects.toThrow(/workspace is required/i);
      await expect(store.getSummary(UID, WS, "")).rejects.toThrow(/session id is required/i);
    }
  });

  test("one account cannot read another's records in the SAME workspace", async () => {
    const store = createListenInMemoryStore();
    await seedSealedSession(store);
    expect(await store.listSessions("uid-other", WS)).toEqual([]);
    expect(await store.getSession("uid-other", WS, "s-seed")).toBeNull();
    expect(await store.listChunks("uid-other", WS, "s-seed")).toEqual([]);
    expect(await store.getChunkAudio("uid-other", WS, "s-seed", 0)).toBeNull();
    expect(await store.getSummary("uid-other", WS, "s-seed")).toBeNull();
    // The owner still has all of it.
    expect(await store.listSessions(UID, WS)).toHaveLength(1);
  });
});

/* ================= 5. no cloud path for Listen In audio ================== */

describe("5. no Listen In audio has any path to the cloud", () => {
  const LISTEN_IN_MODULES = [
    "lib/listenIn/listenInEngine.js",
    "lib/listenIn/listenInStore.js",
    "lib/listenIn/listenInModel.js",
    "lib/listenIn/listenInSummaryModel.js",
    "lib/listenIn/listenInSummaryClient.js",
    "lib/listenIn/listenInPolicy.js",
    "lib/listenIn/listenInExport.js",
  ];

  test("no Listen In module IMPORTS Firebase, cloud sync or the asset upload layer", () => {
    // Reachability, not vocabulary: `listenInPolicy.js` names Firebase Storage
    // in the approved policy text precisely in order to promise that nothing
    // is uploaded to it, and a test that failed on the word would punish the
    // module for making the promise. What must not exist is a way to GET
    // there, so the imports are what is checked.
    for (const file of LISTEN_IN_MODULES) {
      const source = code(src(file));
      const imports = [
        ...(source.match(/^\s*import[\s\S]*?from\s+["'][^"']+["']/gm) || []),
        ...(source.match(/require\(\s*["'][^"']+["']\s*\)/g) || []),
      ].join("\n");
      expect({
        file,
        hit: /firebase|firestore|cloud\/|cloudSync|assetUpload|assetRemoteIndex|assetStorage/i.test(imports),
      }).toEqual({ file, hit: false });
    }
  });

  test("no Listen In module CALLS an upload, a cloud write or a queue", () => {
    for (const file of LISTEN_IN_MODULES) {
      const source = code(src(file));
      expect({
        file,
        hit: /\b(uploadBytes|uploadBytesResumable|getDownloadURL|setDoc|addDoc|updateDoc|enqueueAssetUpload|queueAssetUpload)\s*\(/.test(
          source
        ),
      }).toEqual({ file, hit: false });
    }
  });

  test("the tracked policy states the cloud promise, so losing it is a source change", () => {
    expect(LISTEN_IN_PERSISTENCE_POLICY.cloud).toMatch(/never uploaded to Firebase Storage/i);
    expect(LISTEN_IN_PERSISTENCE_POLICY.cloud).toMatch(/\/api\/transcribe/);
  });
});

/* ============ 6. an identity transition interrupts live capture ========== */

describe("6. an authenticated identity change stops that account's capture", () => {
  test("it seals, releases the microphone, leaves the session interrupted and deletes nothing", async () => {
    const store = createListenInMemoryStore();
    const engine = getListenInEngine(UID, WS, {
      store,
      transcribe: async () => "words",
      summarise: async () => ({ ok: false, outcome: "failure", message: "not in this test" }),
      recorderSupported: () => true,
    });
    await engine.start({ language: "en" });
    await settle();
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    const sessionId = engine.getSnapshot().session.sessionId;

    // The authenticated user becomes somebody else. This is the auth boundary
    // acting, not a button. (The full matrix is in listenInEngine.test.js.)
    const suspended = applyListenInIdentity("uid-somebody-else");
    await settle();

    expect(suspended).toContain(WS);
    expect(currentMicrophoneOwner()).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalled();
    // NOTHING WAS DELETED: the work stays under its owner's uid, interrupted.
    const kept = await store.getSession(UID, WS, sessionId);
    expect(kept).not.toBeNull();
    expect(kept.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
  });
});

/* ========== 7/8. audio released on success, retained on failure ========== */

describe("7. a chunk's audio is deleted as soon as its transcript is stored", () => {
  test("the bytes are gone and the words are kept", async () => {
    const store = createListenInMemoryStore();
    await seedSealedSession(store);
    const engine = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store,
      transcribe: async () => "the words that were said",
      summarise: async () => ({ ok: false, outcome: "failure", message: "off" }),
      recorderSupported: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 0,
      clearInterval_: () => {},
    });
    await engine.bootstrap();
    await settle();
    await engine.flush();
    await settle();

    const [chunk] = await store.listChunks(UID, WS, "s-seed");
    expect(chunk.state).toBe(CHUNK_STATE.TRANSCRIBED);
    expect(chunk.text).toBe("the words that were said");
    expect(await store.getChunkAudio(UID, WS, "s-seed", 0)).toBeNull();
    engine.shutdown();
  });
});

describe("8. a chunk that FAILED keeps its audio, so a retry is a real retry", () => {
  test("the bytes are still there and the failure is recorded", async () => {
    const store = createListenInMemoryStore();
    await seedSealedSession(store);
    const engine = createListenInEngine({
      uid: UID,
      workspaceId: WS,
      store,
      transcribe: async () => {
        throw new Error("Network error");
      },
      summarise: async () => ({ ok: false, outcome: "failure", message: "off" }),
      recorderSupported: () => true,
      setTimer: () => 0,
      clearTimer: () => {},
      setInterval_: () => 0,
      clearInterval_: () => {},
    });
    await engine.bootstrap();
    await settle();
    await engine.flush();
    await settle();

    const [chunk] = await store.listChunks(UID, WS, "s-seed");
    expect(chunk.state).toBe(CHUNK_STATE.FAILED);
    const audio = await store.getChunkAudio(UID, WS, "s-seed", 0);
    expect(audio).not.toBeNull();
    expect(audio.size).toBeGreaterThan(0);
    engine.shutdown();
  });
});

/* ============ 9. discard is the only thing that removes a session ======== */

describe("9. discarding removes the header, the chunks, the audio and the summary", () => {
  test("nothing of the session is left behind", async () => {
    const store = createListenInMemoryStore();
    await seedSealedSession(store);
    await store.putSummary({
      uid: UID,
      workspaceId: WS,
      sessionId: "s-seed",
      result: { summaryText: "what it was about" },
    });
    await store.deleteSession(UID, WS, "s-seed");
    expect(await store.getSession(UID, WS, "s-seed")).toBeNull();
    expect(await store.listChunks(UID, WS, "s-seed")).toEqual([]);
    expect(await store.getChunkAudio(UID, WS, "s-seed", 0)).toBeNull();
    expect(await store.getSummary(UID, WS, "s-seed")).toBeNull();
  });
});

/* ================= 10. the summary route is TEXT-ONLY ==================== */

describe("10. no audio can reach the Listen In summary route", () => {
  test("the route itself has no audio path", () => {
    const route = code(fs.readFileSync(path.join(ROOT, "routes", "listenInSummary.js"), "utf8"));
    expect(route).not.toMatch(/multer|audio|transcriptions|Blob|FormData|diskStorage/i);
  });

  test("the client sends the validated contract fields and nothing else", () => {
    const client = code(src("lib/listenIn/listenInSummaryClient.js"));
    expect(client).not.toMatch(/Blob|FormData|audio|getChunkAudio/i);
    // The body is re-serialised from the VALIDATED value, so nothing the
    // caller passed that the contract does not name can travel.
    expect(client).toMatch(/body: JSON\.stringify\(/);
    expect(client).toMatch(/request\.value\.mode/);
  });

  test("the engine's summary loop reads transcript text, never a chunk's bytes", () => {
    const engine = code(src("lib/listenIn/listenInEngine.js"));
    const loop = engine.slice(
      engine.indexOf("async function runSummary()"),
      engine.indexOf("async function bootstrap()")
    );
    expect(loop.length).toBeGreaterThan(200);
    expect(loop).not.toMatch(/getChunkAudio|Blob|FormData/);
    expect(loop).toMatch(/segments: window\.segments/);
  });

  test("the summary is stored locally only — it has no cloud path either", () => {
    const store = code(src("lib/listenIn/listenInStore.js"));
    expect(store).toMatch(/LISTEN_IN_SUMMARY_STORE/);
    expect(store).not.toMatch(/firebase|uploadBytes|firestore/i);
  });
});

/* ================= 11. the route keeps the same policy chain ============= */

describe("11. every provider-backed route is behind the same identity policy", () => {
  const app = code(fs.readFileSync(path.join(ROOT, "server", "app.js"), "utf8"));

  test("all three routes are mounted through providerRoutePolicy, none without one", () => {
    const mounts = app.match(/\.\.\.providerRoutePolicy\(/g) || [];
    expect(mounts).toHaveLength(3);
    // The summary route is one of them, with its OWN budget rather than a
    // limit sized for a different cost profile.
    expect(app).toMatch(/"\/api\/listen-in\/summary"/);
    expect(app).toMatch(/config\.rateLimits\.listenInSummary/);
    expect(app).toMatch(/config\.limits\.listenInSummaryJsonBytes/);
  });

  test("the policy chain itself is unchanged: IP limit, token, verified email, user limit", () => {
    const chain = app.slice(
      app.indexOf("function providerRoutePolicy("),
      app.indexOf("/* ---------------------------- error contract")
    );
    const body = chain || app;
    expect(body).toMatch(/ipRateLimit\(/);
    expect(body).toMatch(/requireFirebaseUser\(/);
    expect(body).toMatch(/requireVerifiedEmail\(\)/);
    expect(body).toMatch(/userRateLimit\(/);
  });
});
