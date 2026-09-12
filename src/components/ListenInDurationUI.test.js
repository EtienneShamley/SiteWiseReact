// src/components/ListenInDurationUI.test.js
//
// WHAT THE USER IS TOLD ABOUT A LONG SESSION (Phase 8D.3).
//
// The REAL Listen In window over the REAL engine, with the clock injected so
// two and four hours of meeting take a few milliseconds. Nothing here is
// asserted from source text, and nothing is stubbed except the microphone, the
// recorder, the transports and the clock.
//
// The four things the window must get right:
//
//   - at two hours it SAYS SO and keeps recording — no control changes, no
//     Stop, no pause, and the message does not repeat;
//   - at four hours it says capture stopped and that nothing was lost, with
//     NO action asked of the user;
//   - an interrupted session that has used its whole budget does not offer
//     Resume, and says why;
//   - closing the window during any of this costs the session nothing.
import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import LiveTranscriptDialog from "./LiveTranscriptDialog";
import { LiveTranscriptContext } from "../context/LiveTranscriptContext";
import useLiveTranscript from "../hooks/useLiveTranscript";
import {
  getListenInEngine,
  resetListenInEnginesForTests,
} from "../lib/listenIn/listenInEngine";
import {
  LISTEN_IN_MESSAGE,
  LISTEN_IN_STATE,
  LISTEN_IN_STOP_REASON,
} from "../lib/listenIn/listenInModel";
import {
  LISTEN_IN_MAX_CAPTURE_MS,
  LISTEN_IN_WARN_AFTER_MS,
} from "../lib/listenIn/listenInPolicy";
import { createListenInMemoryStore } from "../lib/listenIn/listenInStore";
import {
  currentMicrophoneOwner,
  resetMicrophoneOwnershipForTests,
} from "../lib/microphoneOwnership";

global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../hooks/useRefine", () => ({
  useRefine: () => ({ refineText: jest.fn() }),
}));

class FakeMediaRecorder {
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
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob([new Uint8Array(8)], { type: this.mimeType }) });
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

const UID = "uid-duration";
const WS = "ws-duration";

let host;
let root;
let clock;
let roll;
let store;

beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
  clock = 1_700_000_000_000;
  roll = null;
  store = createListenInMemoryStore();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
    configurable: true,
  });
});

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
  resetListenInEnginesForTests();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const advance = (ms) => {
  clock += ms;
};

/** The real dialog, over the real engine, inside the real context shape. */
function Harness({ api }) {
  const session = useLiveTranscript({ uid: UID, workspaceId: WS });
  const [open, setOpen] = useState(true);
  api.current = { session, setOpen };
  return (
    <LiveTranscriptContext.Provider
      value={{
        ...session,
        language: "auto",
        chooseLanguage: () => {},
        open,
        openWorkspace: () => setOpen(true),
        closeWorkspace: () => setOpen(false),
        insertTarget: { canInsert: false, noteTitle: "", reason: "Open a note." },
        registerInsertTarget: () => {},
        insertTranscript: () => false,
      }}
    >
      <LiveTranscriptDialog />
    </LiveTranscriptContext.Provider>
  );
}

function mount({ transcribe } = {}) {
  getListenInEngine(UID, WS, {
    store,
    transcribe: transcribe || (async () => "some meeting words"),
    summarise: async () => ({ ok: false, outcome: "failure", message: "no summary" }),
    summaryEnabled: false,
    recorderSupported: () => true,
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
    addOnlineListener: () => () => {},
    addWakeListener: () => () => {},
    newSessionId: () => "session-ui",
  });
  const api = { current: null };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness api={api} />));
  return api;
}

const warning = () => document.querySelector('[data-listen-in-duration="warning"]');
const limit = () => document.querySelector('[data-listen-in-duration="limit"]');
const exhausted = () => document.querySelector('[data-listen-in-duration="exhausted"]');
const buttons = () => [...document.querySelectorAll("button")];
const byText = (re) => buttons().find((b) => re.test(b.textContent.trim()));
const text = () => document.body.textContent;

/* =========================== 28. the 2 h warning ========================= */

describe("28. the two-hour warning is shown, and recording carries on", () => {
  test("nothing is shown before two hours", async () => {
    const api = mount();
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    advance(LISTEN_IN_WARN_AFTER_MS - 60000);
    await act(async () => {
      roll();
    });
    await flush();
    expect(warning()).toBeNull();
    expect(text()).not.toContain(LISTEN_IN_MESSAGE.DURATION_WARNING);
    expect(api.current.session.recording).toBe(true);
  });

  test("at two hours the warning appears and the session is STILL RECORDING", async () => {
    const api = mount();
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    advance(LISTEN_IN_WARN_AFTER_MS);
    await act(async () => {
      roll();
    });
    await flush();

    expect(warning()).not.toBeNull();
    expect(warning().textContent).toBe(LISTEN_IN_MESSAGE.DURATION_WARNING);
    // It is a polite status, not an alert — nothing has gone wrong.
    expect(warning().querySelector('[role="status"]')).not.toBeNull();
    // It says both halves: recording continues, and it stops at four hours.
    expect(warning().textContent).toMatch(/will continue/i);
    expect(warning().textContent).toMatch(/4 hours/);

    // The record control is unchanged: still Stop recording, still enabled,
    // and the meeting can still be completed.
    expect(api.current.session.recording).toBe(true);
    expect(byText(/^Stop recording$/)).toBeDefined();
    expect(byText(/^Stop recording$/).disabled).toBe(false);
    expect(byText(/^Complete meeting$/)).toBeDefined();
    expect(currentMicrophoneOwner()).toBe("live-transcript");
    // And no limit notice is shown, because the limit has not been reached.
    expect(limit()).toBeNull();
  });

  test("the warning is ONE banner however many chunks roll after it", async () => {
    const api = mount();
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    advance(LISTEN_IN_WARN_AFTER_MS);
    await act(async () => {
      roll();
    });
    await flush();
    for (let i = 0; i < 4; i += 1) {
      advance(10 * 60 * 1000);
      await act(async () => {
        roll();
      });
      await flush();
    }
    expect(document.querySelectorAll('[data-listen-in-duration="warning"]')).toHaveLength(1);
    expect(api.current.session.recording).toBe(true);
  });

  test("closing the window and reopening it finds the SAME warning, not a new one", async () => {
    const api = mount();
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    advance(LISTEN_IN_WARN_AFTER_MS);
    await act(async () => {
      roll();
    });
    await flush();
    const warnedAt = api.current.session.session.limitWarnedAt;

    act(() => api.current.setOpen(false));
    await flush();
    expect(warning()).toBeNull();
    // The capture never noticed.
    expect(api.current.session.recording).toBe(true);

    advance(5 * 60 * 1000);
    act(() => api.current.setOpen(true));
    await flush();
    expect(warning()).not.toBeNull();
    expect(api.current.session.session.limitWarnedAt).toBe(warnedAt);
  });
});

/* ========================= 29/32. the 4 h hard stop ====================== */

describe("29/32. the four-hour limit is communicated, and asks nothing of the user", () => {
  test("the session stops itself and the window says what happened", async () => {
    const api = mount();
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    advance(LISTEN_IN_MAX_CAPTURE_MS);
    await act(async () => {
      roll();
    });
    await flush();

    expect(limit()).not.toBeNull();
    expect(limit().textContent).toBe(LISTEN_IN_MESSAGE.LIMIT_REACHED);
    expect(limit().querySelector('[role="status"]')).not.toBeNull();
    // It states that nothing was lost, which "stopped automatically" alone
    // would not.
    expect(limit().textContent).toMatch(/safe/i);

    // 32. No manual action was required and none is offered: no Stop, no
    // confirmation, no dialog. The record control is back to Start.
    expect(byText(/^Stop$/)).toBeUndefined();
    expect(api.current.session.recording).toBe(false);
    expect(api.current.session.stoppedAtLimit).toBe(true);
    expect(api.current.session.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);
    // The microphone really is released.
    expect(currentMicrophoneOwner()).toBeNull();
    // The two-hour warning is replaced rather than stacked on top.
    expect(warning()).toBeNull();
  });

  test("31. the finishing state stays visible, and closing the window changes nothing", async () => {
    // Transcription is still running, so the session is genuinely FINISHING —
    // which is the state the window must keep showing while the user is
    // somewhere else entirely.
    const api = mount({ transcribe: () => new Promise(() => {}) });
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    advance(LISTEN_IN_MAX_CAPTURE_MS);
    await act(async () => {
      roll();
    });
    await flush();
    expect(api.current.session.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(text()).toMatch(/Completing meeting/);
    // 32. Nothing to press: no Stop, no Start, no Resume, no Complete — only
    // Close.
    expect(byText(/^Stop recording$/)).toBeUndefined();
    expect(byText(/^Start recording$/)).toBeUndefined();
    expect(byText(/^Resume/)).toBeUndefined();
    expect(byText(/^Complete meeting$/)).toBeUndefined();
    expect(byText(/^Close$/)).toBeDefined();

    // 22/23. The user closes the window and goes elsewhere.
    act(() => api.current.setOpen(false));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The session is untouched and still finishing on its own.
    expect(api.current.session.session.state).toBe(LISTEN_IN_STATE.FINISHING);
    expect(api.current.session.session.stopReason).toBe(LISTEN_IN_STOP_REASON.LIMIT);

    act(() => api.current.setOpen(true));
    await flush();
    expect(limit()).not.toBeNull();
  });
});

/* ==================== the interrupted session's choices ================= */

describe("an interrupted session offers only what it can actually do", () => {
  test("with budget left it offers Resume and Finish and explains itself", async () => {
    await store.putSession({
      uid: UID,
      workspaceId: WS,
      sessionId: "session-ui",
      title: "Listen In",
      startedAt: clock - 60000,
      stoppedAt: clock,
      capturedMs: 30 * 60 * 1000,
      legStartedAt: null,
      state: LISTEN_IN_STATE.INTERRUPTED,
      stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
      limitWarnedAt: null,
      language: "auto",
      nextSeq: 2,
      updatedAt: clock,
    });
    const api = mount();
    await flush();

    expect(api.current.session.interrupted).toBe(true);
    expect(api.current.session.canResume).toBe(true);
    expect(byText(/^Resume meeting$/)).toBeDefined();
    expect(byText(/^Complete meeting$/)).toBeDefined();
    expect(text()).toContain(LISTEN_IN_MESSAGE.INTERRUPTED);
    expect(exhausted()).toBeNull();
  });

  test("1. a STOPPED meeting below the limit offers Start recording and no limit notice", async () => {
    await store.putSession({
      uid: UID,
      workspaceId: WS,
      sessionId: "session-ui",
      title: "Listen In",
      startedAt: clock - 40 * 60 * 1000,
      stoppedAt: null,
      // Internally `paused`: the user stopped recording and the meeting is
      // still open. Well inside the four hours.
      capturedMs: 40 * 60 * 1000,
      legStartedAt: null,
      state: LISTEN_IN_STATE.PAUSED,
      stopReason: null,
      limitWarnedAt: null,
      language: "auto",
      nextSeq: 80,
      updatedAt: clock,
    });
    const api = mount();
    await flush();

    expect(api.current.session.paused).toBe(true);
    expect(api.current.session.canResume).toBe(true);
    expect(byText(/^Start recording$/)).toBeDefined();
    expect(byText(/^Complete meeting$/)).toBeDefined();
    expect(byText(/^Close$/)).toBeDefined();
    // Nothing to explain: recording can simply start again.
    expect(exhausted()).toBeNull();
    expect(text()).not.toContain(LISTEN_IN_MESSAGE.LIMIT_EXHAUSTED);
    // And a stopped meeting is never presented as an interruption.
    expect(text()).not.toContain(LISTEN_IN_MESSAGE.INTERRUPTED);
  });

  test("2/3/4/5. a STOPPED meeting AT the limit loses Start recording and says WHY, keeping Complete and Close", async () => {
    await store.putSession({
      uid: UID,
      workspaceId: WS,
      sessionId: "session-ui",
      title: "Listen In",
      startedAt: clock - 5 * 60 * 60 * 1000,
      stoppedAt: null,
      capturedMs: LISTEN_IN_MAX_CAPTURE_MS,
      legStartedAt: null,
      state: LISTEN_IN_STATE.PAUSED,
      stopReason: null,
      limitWarnedAt: clock - 3 * 60 * 60 * 1000,
      language: "auto",
      nextSeq: 480,
      updatedAt: clock,
    });
    const api = mount();
    await flush();

    expect(api.current.session.paused).toBe(true);
    expect(api.current.session.duration.exhausted).toBe(true);
    expect(api.current.session.canResume).toBe(false);
    // 2. no way to record again…
    expect(byText(/^Start recording$/)).toBeUndefined();
    expect(byText(/^Resume/)).toBeUndefined();
    // 3. …and the window says why, rather than leaving two silent buttons.
    expect(exhausted()).not.toBeNull();
    expect(exhausted().textContent).toBe(LISTEN_IN_MESSAGE.LIMIT_EXHAUSTED);
    expect(exhausted().querySelector('[role="status"]')).not.toBeNull();
    expect(exhausted().textContent).toMatch(/4-hour recording limit/i);
    expect(exhausted().textContent).toMatch(/Complete the meeting/i);
    // A deliberate stop is never dressed up as a crash.
    expect(text()).not.toContain(LISTEN_IN_MESSAGE.INTERRUPTED);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    // 4/5. the two things it CAN still do are both there.
    expect(byText(/^Complete meeting$/)).toBeDefined();
    expect(byText(/^Close$/)).toBeDefined();
    // 7. and nothing about the lifecycle moved: still stopped, still active,
    // still holding no microphone.
    expect(api.current.session.session.state).toBe(LISTEN_IN_STATE.PAUSED);
    expect(api.current.session.active).toBe(true);
    expect(api.current.session.session.stopReason).toBeNull();
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("6/12. with the budget spent there is NO Resume, and the reason is stated", async () => {
    await store.putSession({
      uid: UID,
      workspaceId: WS,
      sessionId: "session-ui",
      title: "Listen In",
      startedAt: clock - LISTEN_IN_MAX_CAPTURE_MS,
      stoppedAt: clock,
      capturedMs: LISTEN_IN_MAX_CAPTURE_MS,
      legStartedAt: null,
      state: LISTEN_IN_STATE.INTERRUPTED,
      stopReason: LISTEN_IN_STOP_REASON.INTERRUPTION,
      limitWarnedAt: clock - 60000,
      language: "auto",
      nextSeq: 9,
      updatedAt: clock,
    });
    const api = mount();
    await flush();

    expect(api.current.session.interrupted).toBe(true);
    expect(api.current.session.canResume).toBe(false);
    expect(byText(/^Resume/)).toBeUndefined();
    // Complete meeting is still there — it is the one thing that keeps the work.
    expect(byText(/^Complete meeting$/)).toBeDefined();
    expect(exhausted()).not.toBeNull();
    expect(exhausted().textContent).toBe(LISTEN_IN_MESSAGE.LIMIT_EXHAUSTED);
    expect(exhausted().textContent).toMatch(/4-hour recording limit/i);
    expect(exhausted().textContent).toMatch(/cannot record any more/i);
    // And no microphone was opened by rendering any of this.
    expect(currentMicrophoneOwner()).toBeNull();
  });
});
