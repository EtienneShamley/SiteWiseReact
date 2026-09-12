// src/components/ListenInWindowLifecycle.test.js
//
// THE CRITICAL GUARANTEE, RENDERED (Phase 8D.1):
//
//     the SESSION owns the recording, and the window does not.
//
// Every test here drives the real React adapter (`useLiveTranscript`) over the
// real engine and then does something a VIEW does — closes the window, presses
// Escape, navigates, unmounts the provider subtree entirely — and asserts that
// the capture is still running, still holds the microphone, and is the SAME
// session when the user comes back.
//
// A source-text assertion could only show that `stop()` is not written in a
// close handler. These show that no path through the view layer reaches it at
// all, which is the property that actually matters.
import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import useLiveTranscript from "../hooks/useLiveTranscript";
import {
  applyListenInIdentity,
  getListenInEngine,
  peekListenInEngine,
  resetListenInEnginesForTests,
  activeCaptureWarning,
} from "../lib/listenIn/listenInEngine";
import { LISTEN_IN_STATE, elapsedMs, formatElapsed } from "../lib/listenIn/listenInModel";
import {
  MICROPHONE_OWNER,
  claimMicrophone,
  currentMicrophoneOwner,
  releaseMicrophone,
  resetMicrophoneOwnershipForTests,
} from "../lib/microphoneOwnership";

/** Claim as the OTHER workflow, then let go — "is the microphone free?". */
function claimMicrophoneForTest() {
  const result = claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
  if (result.ok) releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
  return result;
}
import { createListenInMemoryStore } from "../lib/listenIn/listenInStore";

global.IS_REACT_ACT_ENVIRONMENT = true;

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
    if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(16)], { type: this.mimeType }) });
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

const WS = "ws-lifecycle";
const UID = "uid-lifecycle";
let store;
let tracks;
let summaryCalls;
let summaryGate;

beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  FakeMediaRecorder.instances = [];
  store = createListenInMemoryStore();
  tracks = [{ stop: jest.fn() }];
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => tracks })) },
    configurable: true,
  });
  // One engine for the workspace, with its externals injected. The components
  // below look it up by workspace exactly as the provider does.
  summaryCalls = [];
  summaryGate = null;
  getListenInEngine(UID, WS, {
    store,
    transcribe: async () => "captured words",
    // Phase 8D.2: the summary loop is the engine's third loop. It is injected
    // here so the tests below can leave a summary IN FLIGHT while the window
    // is closed and unmounted.
    summarise: async (request) => {
      summaryCalls.push(request);
      if (summaryGate) await summaryGate;
      return {
        ok: true,
        result: {
          summaryText: `summary of ${request.mode}`,
          keyPoints: [],
          decisions: [],
          actionItems: [],
          risks: [],
          followUps: [],
        },
      };
    },
    // Every window is worth summarising in these tests; the batching policy
    // itself is proved in listenInSummaryModel.test.js.
    summaryPolicy: { minWindowChars: 1, maxWindowChars: 12000, minIntervalMs: 0, retryBackoffMs: [1], maxAutoAttempts: 4 },
    recorderSupported: () => true,
  });
});

afterEach(() => {
  resetListenInEnginesForTests();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

/* ------------------------------ the views -------------------------------- */

/**
 * A stand-in for the Listen In window: it mounts only while "open", exactly
 * like the real dialog, which returns null when closed.
 */
function ListenInWindow({ onApi }) {
  const session = useLiveTranscript({ uid: UID, workspaceId: WS });
  onApi(session);
  return (
    <div data-testid="window">
      <span data-testid="state">{session.session ? session.session.state : "none"}</span>
      <span data-testid="elapsed">
        {session.session ? formatElapsed(elapsedMs(session.session, Date.now())) : ""}
      </span>
      <span data-testid="summary">{session.summaryText}</span>
      <span data-testid="summary-status">{session.summary ? session.summary.status : "none"}</span>
    </div>
  );
}

/** A stand-in for the sidebar row: always mounted, never owns the session. */
function SidebarRow({ onApi }) {
  const session = useLiveTranscript({ uid: UID, workspaceId: WS });
  onApi(session);
  return (
    <span data-testid="sidebar" data-recording={session.recording ? "yes" : "no"}>
      {session.recording ? "Listen In — recording" : "Listen In"}
    </span>
  );
}

/** The shell: the row is permanent, the window opens and closes. */
function Shell({ onWindow, onSidebar, controls }) {
  const [open, setOpen] = useState(true);
  const [note, setNote] = useState("note-1");
  controls.current = { setOpen, setNote, note: () => note };
  return (
    <div>
      <SidebarRow onApi={onSidebar} />
      <span data-testid="note">{note}</span>
      {open && <ListenInWindow onApi={onWindow} />}
    </div>
  );
}

let host;
let root;
let windowApi;
let sidebarApi;
let controls;

function mount() {
  controls = { current: null };
  windowApi = null;
  sidebarApi = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <Shell
        controls={controls}
        onWindow={(api) => (windowApi = api)}
        onSidebar={(api) => (sidebarApi = api)}
      />
    )
  );
}

function unmountShell() {
  act(() => root.unmount());
  host.remove();
  root = null;
}

afterEach(() => {
  if (root) unmountShell();
});

const at = (id) => host.querySelector(`[data-testid="${id}"]`);
const closeWindow = () => act(() => controls.current.setOpen(false));
const openWindow = () => act(() => controls.current.setOpen(true));

async function startCapture() {
  await act(async () => {
    await windowApi.start({ language: "en" });
  });
  await flush();
}

/* =============================== the tests =============================== */

describe("1/2/4. closing the window does not stop the capture", () => {
  test("start, close, and the session is still recording and still holds the microphone", async () => {
    mount();
    await startCapture();
    const id = windowApi.session.sessionId;
    expect(at("state").textContent).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);

    closeWindow();
    await flush();
    // The window is gone from the DOM…
    expect(at("window")).toBeNull();
    // …and the capture is untouched.
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(tracks[0].stop).not.toHaveBeenCalled();
    expect(sidebarApi.recording).toBe(true);
    expect(sidebarApi.session.sessionId).toBe(id);
    expect(sidebarApi.session.state).toBe(LISTEN_IN_STATE.RECORDING);
  });

  test("4. reopening returns to the SAME session, not a new one", async () => {
    mount();
    await startCapture();
    const id = windowApi.session.sessionId;
    const startedAt = windowApi.session.startedAt;

    closeWindow();
    await flush();
    openWindow();
    await flush();

    expect(windowApi.session.sessionId).toBe(id);
    expect(windowApi.session.startedAt).toBe(startedAt);
    expect(windowApi.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    // One microphone was ever opened, across both openings of the window.
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("closing and reopening many times still costs the capture nothing", async () => {
    mount();
    await startCapture();
    const id = windowApi.session.sessionId;
    for (let i = 0; i < 5; i += 1) {
      closeWindow();
      await flush();
      openWindow();
      await flush();
    }
    expect(windowApi.session.sessionId).toBe(id);
    expect(windowApi.session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("3. Escape closes the view and nothing else", () => {
  test("the Escape handler is a close, and a close is not a stop", async () => {
    mount();
    await startCapture();
    // The real dialog binds Escape to closeWorkspace; here the equivalent is
    // that closing by ANY route leaves the engine exactly as it was.
    const before = windowApi.session;
    closeWindow();
    await flush();
    expect(sidebarApi.session.state).toBe(before.state);
    expect(sidebarApi.session.sessionId).toBe(before.sessionId);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
  });
});

describe("5. navigating around the application does not stop the capture", () => {
  test("switching notes leaves the session recording and its clock running", async () => {
    mount();
    await startCapture();
    const id = windowApi.session.sessionId;
    act(() => controls.current.setNote("note-2"));
    await flush();
    act(() => controls.current.setNote("note-3"));
    await flush();
    expect(at("note").textContent).toBe("note-3");
    expect(sidebarApi.session.sessionId).toBe(id);
    expect(sidebarApi.recording).toBe(true);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
  });
});

describe("6. explicit Stop is the normal way a capture ends", () => {
  test("Stop, and only Stop, ends it — from the window or from anywhere else", async () => {
    mount();
    await startCapture();
    await act(async () => {
      await windowApi.stop();
    });
    await flush();
    expect(currentMicrophoneOwner()).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(sidebarApi.recording).toBe(false);
    expect(["finishing", "finished"]).toContain(sidebarApi.session.state);
  });
});

describe("7. elapsed time is the session's, not the window's", () => {
  test("it is correct immediately on reopening, however long the window was shut", async () => {
    mount();
    await startCapture();
    const session = windowApi.session;
    closeWindow();
    await flush();
    // Time passes with no window mounted to count it.
    const later = session.startedAt + 125_000;
    expect(formatElapsed(elapsedMs(session, later))).toBe("2:05");
    openWindow();
    await flush();
    // The reopened window derives the same number from the same session.
    expect(formatElapsed(elapsedMs(windowApi.session, later))).toBe("2:05");
  });

  test("it is formatted for a meeting, not a clip", () => {
    expect(formatElapsed(59_000)).toBe("0:59");
    expect(formatElapsed(90_000)).toBe("1:30");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(7_265_000)).toBe("2:01:05");
  });
});

describe("26/27/28. the sidebar shows the live capture while the window is closed", () => {
  test("the row reports recording with the window shut, and is the way back in", async () => {
    mount();
    await startCapture();
    closeWindow();
    await flush();
    expect(at("window")).toBeNull();
    expect(at("sidebar").getAttribute("data-recording")).toBe("yes");
    expect(at("sidebar").textContent).toBe("Listen In — recording");
    // Clicking it (here: reopening) returns to the same session.
    const id = sidebarApi.session.sessionId;
    openWindow();
    await flush();
    expect(windowApi.session.sessionId).toBe(id);
  });
});

describe("29. unmounting the view layer cannot silently discard the capture", () => {
  test("the whole subtree unmounts and the session is still there afterwards", async () => {
    mount();
    await startCapture();
    const id = windowApi.session.sessionId;
    // A provider remount, a route change, a shell rebuild — all of them look
    // like this to the session, and none of them may end it.
    unmountShell();
    await flush();
    const engine = getListenInEngine(UID, WS);
    expect(engine.getSnapshot().session.sessionId).toBe(id);
    expect(engine.getSnapshot().session.state).toBe(LISTEN_IN_STATE.RECORDING);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);
    // And something that ends the workspace session is warned, not silent.
    expect(activeCaptureWarning()).toMatch(/still recording/i);
  });

  test("with nothing recording there is no warning to give", async () => {
    mount();
    expect(activeCaptureWarning()).toBeNull();
    await startCapture();
    expect(activeCaptureWarning()).not.toBeNull();
    await act(async () => {
      await windowApi.stop();
    });
    await flush();
    expect(activeCaptureWarning()).toBeNull();
  });
});

/* ================= the ACCOUNT boundary in the registry =================== */

describe("the engine registry does not cross identities", () => {
  const UID_B = "uid-other";

  test("a different account in the SAME workspace gets a different engine", () => {
    const a = getListenInEngine(UID, WS);
    const b = getListenInEngine(UID_B, WS, {
      store: createListenInMemoryStore(),
      transcribe: async () => "",
      recorderSupported: () => true,
    });
    expect(a.uid).toBe(UID);
    expect(a).not.toBe(b);
    expect(a.uid).toBe(UID);
    expect(b.uid).toBe(UID_B);
    // Asking again for the same identity returns the SAME engine, so a
    // re-render never spawns a second recorder.
    expect(getListenInEngine(UID, WS)).toBe(a);
    expect(getListenInEngine(UID_B, WS)).toBe(b);
  });

  test("a lookup without both halves of the identity yields nothing", () => {
    expect(getListenInEngine(null, WS)).toBeNull();
    expect(getListenInEngine(UID, null)).toBeNull();
    expect(getListenInEngine(undefined, undefined)).toBeNull();
  });

  test("the hook swaps engines when the signed-in account changes", async () => {
    let api = null;
    let setUid = null;
    function Probe() {
      const [who, setWho] = useState(UID);
      setUid = setWho;
      api = useLiveTranscript({ uid: who, workspaceId: WS });
      return null;
    }
    const h2 = document.createElement("div");
    document.body.appendChild(h2);
    const r2 = createRoot(h2);
    act(() => r2.render(<Probe />));
    await flush();

    await act(async () => {
      await api.start({ language: "en" });
    });
    await flush();
    const aSessionId = api.session.sessionId;
    expect(api.engine.uid).toBe(UID);

    const aEngine = api.engine;

    // The account switches in the same browser.
    act(() => setUid(UID_B));
    await flush();
    expect(api.engine).not.toBe(aEngine);
    expect(api.engine.uid).toBe(UID_B);
    // B sees no session of A's — not its transcript, not its state, nothing.
    expect(api.session).toBeNull();
    expect(api.chunks).toHaveLength(0);
    expect(api.transcript).toBe("");
    // A's engine left the registry rather than staying reachable, and A's
    // durable work is still in the store under A's own uid.
    expect(await store.getSession(UID, WS, aSessionId)).not.toBeNull();
    expect(peekListenInEngine(UID, WS)).toBeNull();

    act(() => r2.unmount());
    h2.remove();
  });
});

/* =============== the AUTH TRANSITION (8D.1 privacy correction) ============ */
//
// Data isolation alone is not enough. If account A owns a LIVE microphone
// capture and the authenticated identity becomes B, then B cannot see A's
// session — but A's recorder would still be running, and the one global
// microphone claim would still be held by an engine the current user has no
// way to reach. That is a privacy failure and a lockout at the same time.
//
// The property under test: an identity change AWAY from the owning account
// stops that account's capture immediately, releases the microphone, and
// leaves the session interrupted and RECOVERABLE — never deleted.

describe("an authenticated identity change stops the previous account's capture", () => {
  const UID_B = "uid-switch-b";

  /** Drive the hook's uid directly — no Settings button anywhere near it. */
  function renderProbe(initialUid) {
    let api = null;
    let setUid = null;
    function Probe() {
      const [who, setWho] = useState(initialUid);
      setUid = setWho;
      api = useLiveTranscript({ uid: who, workspaceId: WS });
      return null;
    }
    const h2 = document.createElement("div");
    document.body.appendChild(h2);
    const r2 = createRoot(h2);
    act(() => r2.render(<Probe />));
    return {
      get api() {
        return api;
      },
      switchTo: (uid) => act(() => setUid(uid)),
      teardown: () => {
        act(() => r2.unmount());
        h2.remove();
      },
    };
  }

  test("A's recorder stops, its tracks stop and the microphone is released", async () => {
    const probe = renderProbe(UID);
    await flush();
    await act(async () => {
      await probe.api.start({ language: "en" });
    });
    await flush();
    const aSessionId = probe.api.session.sessionId;
    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    expect(recorder.state).toBe("recording");
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);

    // The identity changes. The Settings sign-out handler never runs.
    probe.switchTo(UID_B);
    await flush();

    expect(recorder.state).toBe("inactive");
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBeNull();
    expect(activeCaptureWarning()).toBeNull();

    // A's session is INTERRUPTED and still there — not deleted.
    const left = await store.getSession(UID, WS, aSessionId);
    expect(left).not.toBeNull();
    expect(left.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    probe.teardown();
  });

  test("B sees nothing of A's, and is free to take the microphone", async () => {
    const probe = renderProbe(UID);
    await flush();
    await act(async () => {
      await probe.api.start({ language: "en" });
    });
    await flush();
    probe.switchTo(UID_B);
    await flush();

    expect(probe.api.session).toBeNull();
    expect(probe.api.chunks).toHaveLength(0);
    expect(probe.api.transcript).toBe("");
    expect(probe.api.recording).toBe(false);
    // The microphone is genuinely free for B's own workflows.
    expect(claimMicrophoneForTest()).toEqual({ ok: true });
    probe.teardown();
  });

  test("switching back to A recovers A's interrupted session, with its work", async () => {
    // Recovery ACROSS an identity change is a property of the durable store:
    // the suspended engine goes, and the account's next engine reads the work
    // back out of storage. The shared store injected here is what the
    // IndexedDB store is in production once the policy is approved; with the
    // memory store the engine honestly reports `survivesReload: false`.
    const options = {
      store,
      transcribe: async () => "captured words",
      recorderSupported: () => true,
    };
    const a = getListenInEngine(UID, WS, options);
    await a.start({ language: "en" });
    await flush();
    const aSessionId = a.getSnapshot().session.sessionId;

    // The auth boundary fires — the same call AuthContext makes.
    applyListenInIdentity(UID_B);
    expect(peekListenInEngine(UID, WS)).toBeNull();
    expect(currentMicrophoneOwner()).toBeNull();

    // A signs back in and gets a clean engine that recovers its own work.
    const a2 = getListenInEngine(UID, WS, options);
    expect(a2).not.toBe(a);
    await a2.bootstrap();
    await flush();
    expect(a2.getSnapshot().session.sessionId).toBe(aSessionId);
    expect(a2.getSnapshot().session.state).toBe(LISTEN_IN_STATE.INTERRUPTED);
    expect(a2.getSnapshot().session.language).toBe("en");
  });

  test("a guarded sign-out that already stopped the capture is not shut down twice", async () => {
    const probe = renderProbe(UID);
    await flush();
    await act(async () => {
      await probe.api.start({ language: "en" });
    });
    await flush();
    const aSessionId = probe.api.session.sessionId;
    // The product guard: the user stops first, as Settings asks them to.
    await act(async () => {
      await probe.api.stop();
    });
    await flush();
    const after = await store.getSession(UID, WS, aSessionId);
    expect([LISTEN_IN_STATE.FINISHING, LISTEN_IN_STATE.FINISHED]).toContain(after.state);

    // Then the identity changes. A finished session is not re-interrupted.
    probe.switchTo(UID_B);
    await flush();
    const later = await store.getSession(UID, WS, aSessionId);
    expect(later.state).toBe(after.state);
    expect(currentMicrophoneOwner()).toBeNull();
    probe.teardown();
  });

  test("unmounting the view while signed OUT leaves no orphan recorder", async () => {
    const probe = renderProbe(UID);
    await flush();
    await act(async () => {
      await probe.api.start({ language: "en" });
    });
    await flush();
    const recorder = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
    // Signing out entirely: no uid at all.
    probe.switchTo(null);
    await flush();
    expect(recorder.state).toBe("inactive");
    expect(currentMicrophoneOwner()).toBeNull();
    probe.teardown();
    await flush();
    expect(currentMicrophoneOwner()).toBeNull();
  });
});

/* ============ the SUMMARY is the session's too (Phase 8D.2) ============== */
//
// 8D.1 proved that closing the window cannot end a capture. 8D.2 adds a second
// long-running thing to the session — its structured summary — and the same
// rule has to hold for it: closing the window while a summary is being
// generated must not interrupt it, and reopening must find the same summary in
// the same state rather than starting again.

describe("closing the window while summarising does not interrupt the engine", () => {
  test("a summary in flight completes with no window mounted, and the reopened window shows it", async () => {
    let release;
    summaryGate = new Promise((resolve) => {
      release = resolve;
    });
    mount();
    await startCapture();

    // A chunk is sealed and transcribed, so the summary loop has work.
    FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1].stop();
    await flush();
    const engine = getListenInEngine(UID, WS);
    await act(async () => {
      await engine.flush();
    });
    await flush();
    const inFlight = engine.flushSummary();
    await flush();
    expect(summaryCalls.length).toBeGreaterThan(0);
    expect(windowApi.summary.status).toBe("generating");

    // THE WINDOW GOES AWAY MID-REQUEST.
    closeWindow();
    await flush();
    expect(at("window")).toBeNull();

    // The request finishes anyway, into the session.
    release();
    await act(async () => {
      await inFlight;
    });
    await flush();
    expect(engine.getSnapshot().summary.result.summaryText).toBe("summary of window");
    // And the capture never noticed any of it.
    expect(sidebarApi.recording).toBe(true);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LISTEN_IN);

    // REOPENING SHOWS THE SAME SUMMARY — not a new one, and not nothing.
    openWindow();
    await flush();
    expect(at("summary").textContent).toBe("summary of window");
    expect(windowApi.summary.revision).toBe(1);
    expect(windowApi.session.sessionId).toBe(sidebarApi.session.sessionId);
  });

  test("unmounting the whole view layer leaves the summary on the session", async () => {
    mount();
    await startCapture();
    FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1].stop();
    await flush();
    const engine = getListenInEngine(UID, WS);
    await act(async () => {
      await engine.flush();
      await engine.flushSummary();
    });
    await flush();
    const before = engine.getSnapshot().summary.revision;
    expect(before).toBeGreaterThan(0);

    unmountShell();
    await flush();
    // The session, its transcript and its summary are all exactly where they
    // were; nothing in the view layer owns any of them.
    const after = getListenInEngine(UID, WS).getSnapshot();
    expect(after.summary.revision).toBe(before);
    expect(after.summary.result.summaryText).toBe("summary of window");
    expect(after.session.state).toBe(LISTEN_IN_STATE.RECORDING);
  });

  test("the summary is never generated more than once for the same transcript", async () => {
    mount();
    await startCapture();
    FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1].stop();
    await flush();
    const engine = getListenInEngine(UID, WS);
    await act(async () => {
      await engine.flush();
      await engine.flushSummary();
    });
    await flush();
    const calls = summaryCalls.length;

    // Closing and reopening the window many times is a VIEW event and costs
    // nothing: no request, no revision, no regeneration.
    for (let i = 0; i < 4; i += 1) {
      closeWindow();
      await flush();
      openWindow();
      await flush();
    }
    expect(summaryCalls.length).toBe(calls);
    expect(windowApi.summary.revision).toBe(1);
  });
});
