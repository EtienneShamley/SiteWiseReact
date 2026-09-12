// src/components/ListenInRecoveryWarning.test.js
//
// SILENT DEGRADATION IS THE FAILURE (Phase 8D.1).
//
// Listen In falls back to a volatile store where the device has no IndexedDB —
// a private window, blocked site data, an unusual browser. It still records,
// because refusing to capture a meeting would be worse. But someone can
// otherwise record two hours believing a reload is survivable, and it is not.
//
// These tests render the REAL window over the REAL engine with each store in
// turn, and assert the warning appears for exactly one of them, persists for
// the life of the non-durable session, and survives the window being closed
// and reopened. They also pin the wording against the one thing it must not
// imply: that closing the Listen In window costs the recording.
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
import { LISTEN_IN_MESSAGE, needsRecoveryWarning } from "../lib/listenIn/listenInModel";
import { createListenInMemoryStore } from "../lib/listenIn/listenInStore";
import { resetMicrophoneOwnershipForTests } from "../lib/microphoneOwnership";

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

const WS = "ws-warn";
const UID = "uid-warn";

/**
 * A store that claims to be durable. The point under test is what the WINDOW
 * does with the engine's report, so the two reports are what differ.
 */
function durableLookingStore() {
  return Object.freeze({ ...createListenInMemoryStore(), survivesReload: true });
}

let host;
let root;
let controls;

beforeEach(() => {
  resetMicrophoneOwnershipForTests();
  resetListenInEnginesForTests();
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

function mount({ durable }) {
  getListenInEngine(UID, WS, {
    store: durable ? durableLookingStore() : createListenInMemoryStore(),
    transcribe: async () => "words",
    recorderSupported: () => true,
  });
  const api = { current: null };
  controls = api;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness api={api} />));
  return api;
}

const banner = () => document.querySelector('[data-listen-in-recovery="unavailable"]');
const recordButton = () =>
  [...document.querySelectorAll("button")].find((b) => /Start recording|Stop/.test(b.textContent));

/* ========================================================================= */

describe("a durable device says nothing", () => {
  test("no warning before recording, and none while recording", async () => {
    const api = mount({ durable: true });
    await flush();
    expect(api.current.session.survivesReload).toBe(true);
    expect(banner()).toBeNull();
    expect(document.body.textContent).not.toMatch(/Recovery unavailable/);

    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    expect(api.current.session.recording).toBe(true);
    expect(banner()).toBeNull();
  });
});

describe("a device without durable recovery is told, and keeps being told", () => {
  test("the warning is there BEFORE recording starts", async () => {
    const api = mount({ durable: false });
    await flush();
    expect(api.current.session.survivesReload).toBe(false);
    expect(banner()).not.toBeNull();
    expect(banner().textContent).toBe(LISTEN_IN_MESSAGE.RECOVERY_UNAVAILABLE);
    expect(banner().querySelector('[role="status"]')).not.toBeNull();
  });

  test("recording is NOT blocked — it warns and still captures", async () => {
    const api = mount({ durable: false });
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    expect(api.current.session.recording).toBe(true);
    expect(api.current.session.session).not.toBeNull();
    expect(banner()).not.toBeNull();
  });

  test("it persists for the whole session and cannot be dismissed away", async () => {
    const api = mount({ durable: false });
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    // There is no control that removes it.
    expect(banner().querySelector("button")).toBeNull();
    // It is still there after the session has been stopped and finished.
    await act(async () => {
      await api.current.session.stop();
    });
    await flush();
    expect(banner()).not.toBeNull();
  });

  test("closing and reopening the Listen In window still shows it", async () => {
    const api = mount({ durable: false });
    await flush();
    await act(async () => {
      await api.current.session.start({ language: "auto" });
    });
    await flush();
    const sessionId = api.current.session.session.sessionId;

    act(() => api.current.setOpen(false));
    await flush();
    expect(banner()).toBeNull(); // the whole window is closed
    // …and the capture carried on regardless, which is the 8D.1 guarantee.
    expect(api.current.session.recording).toBe(true);

    act(() => api.current.setOpen(true));
    await flush();
    expect(api.current.session.session.sessionId).toBe(sessionId);
    expect(banner()).not.toBeNull();
    expect(banner().textContent).toBe(LISTEN_IN_MESSAGE.RECOVERY_UNAVAILABLE);
  });
});

describe("the wording", () => {
  test("it warns about the APP, and says the Listen In window is safe to close", () => {
    const text = LISTEN_IN_MESSAGE.RECOVERY_UNAVAILABLE;
    expect(text).toMatch(/Recovery unavailable on this device\./);
    expect(text).toMatch(/closing or reloading the app may lose this recording/);
    // The one thing it must never imply. Closing the window is explicitly safe,
    // because the session lives in the engine and not in the view.
    expect(text).toMatch(/Closing this Listen In window is safe/);
    expect(text).not.toMatch(/closing this window may lose|do not close this window/i);
  });

  test("the derivation is the engine's report, not the policy flag", () => {
    expect(needsRecoveryWarning({ engine: {}, survivesReload: false })).toBe(true);
    expect(needsRecoveryWarning({ engine: {}, survivesReload: true })).toBe(false);
    // No engine at all (signed out, or a shell above the data scope) is not a
    // degraded capture — there is nothing to warn about.
    expect(needsRecoveryWarning({ engine: null, survivesReload: false })).toBe(false);
    expect(needsRecoveryWarning()).toBe(false);
  });
});
