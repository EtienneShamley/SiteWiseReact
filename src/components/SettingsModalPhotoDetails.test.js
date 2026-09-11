/**
 * @jest-environment jsdom
 */
// src/components/SettingsModalPhotoDetails.test.js
//
// THE "PHOTO DETAILS" SETTING (2026-09-08): the visible documentary stamp is
// chosen in Settings, per workspace, in three modes — not beside the capture
// buttons. Mounted for real with react-dom; the three contexts the panel
// reads are replaced with the smallest values it needs, because what is under
// test is the control's wiring to src/lib/photoDetailsPreference.js, not the
// session machinery around it (that is src/lib/dataScopeShell.test.js).

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("../context/ThemeContext", () => ({ useTheme: () => ({ theme: "light", toggleTheme: () => {} }) }));
jest.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: { uid: "uid-a", email: "a@example.com", emailVerified: true },
    signOut: async () => {},
    resendVerification: async () => {},
  }),
}));
let mockScope = null;
jest.mock("../context/DataScopeContext", () => ({ useOptionalDataScope: () => mockScope }));

import SettingsModal, { PHOTO_DETAILS_LABEL, PHOTO_DETAILS_NOTE, PHOTO_DETAILS_OPTION_LABELS } from "./SettingsModal";
import { DURABLE_SCOPE_KIND, __resetDurableStorageForTests, setDurableScope } from "../lib/durableStorage";
import {
  LEGACY_PHOTO_DETAILS_BOOLEAN_KEY,
  PHOTO_DETAILS_MODE,
  PHOTO_DETAILS_STORAGE_KEY,
  loadPhotoDetailsMode,
} from "../lib/photoDetailsPreference";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const A = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-alice" };
const B = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-bob" };
const { CAMERA_ONLY, CAMERA_AND_ORIGINAL, OFF } = PHOTO_DETAILS_MODE;

/** The least a signed-in workspace session needs to look like to this panel. */
const workspaceScope = (id) => ({
  uid: "uid-a",
  mode: "online",
  workspace: { id },
  sync: null,
  assetSync: null,
  assetBackfill: null,
  assetPrivacy: null,
  assetGc: null,
  localData: null,
  migration: { state: null, run: async () => {} },
  prepareSignOut: async () => ({}),
  refreshLocalData: () => {},
});

let host;
let root;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<SettingsModal open onClose={() => {}} />));
}

function unmount() {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
}

const select = () => host.querySelector("#nw-settings-photo-details");
const choose = (value) =>
  act(() => {
    const el = select();
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
  setDurableScope(A);
  mockScope = workspaceScope("ws-alice");
});

afterEach(unmount);

describe("the control", () => {
  test("it is in Settings, under its label, with the three modes and the note — defaulting to camera photos only", () => {
    mount();
    const el = select();
    expect(el).not.toBeNull();
    expect(el.tagName).toBe("SELECT");
    expect(host.querySelector('label[for="nw-settings-photo-details"]').textContent).toBe(PHOTO_DETAILS_LABEL);
    expect(Array.from(el.options).map((o) => [o.value, o.textContent])).toEqual([
      ["camera-only", "Camera photos only"],
      ["camera-and-original", "Camera + uploaded photos with original details"],
      ["off", "Off"],
    ]);
    expect(el.value).toBe(CAMERA_ONLY);
    expect(PHOTO_DETAILS_OPTION_LABELS[CAMERA_ONLY]).toBe("Camera photos only");
    // The one rule a user needs, stated under the control and wired to it.
    const note = host.querySelector("#nw-settings-photo-details-note");
    expect(note.textContent).toBe(PHOTO_DETAILS_NOTE);
    expect(el.getAttribute("aria-describedby")).toBe("nw-settings-photo-details-note");
    expect(PHOTO_DETAILS_NOTE).toMatch(/only ever use the details stored in the original photo/);
    // Opening the panel writes nothing.
    expect(localStorage.getItem(`notewise-workspace-v1/ws-alice/${PHOTO_DETAILS_STORAGE_KEY}`)).toBeNull();
  });

  test("a change is stored for the workspace and shown again when the panel reopens", () => {
    mount();
    choose(CAMERA_AND_ORIGINAL);
    expect(select().value).toBe(CAMERA_AND_ORIGINAL);
    expect(loadPhotoDetailsMode()).toBe(CAMERA_AND_ORIGINAL);
    expect(localStorage.getItem(`notewise-workspace-v1/ws-alice/${PHOTO_DETAILS_STORAGE_KEY}`)).toBe("camera-and-original");

    unmount();
    mount();
    expect(select().value).toBe(CAMERA_AND_ORIGINAL);

    choose(OFF);
    expect(loadPhotoDetailsMode()).toBe(OFF);
  });

  test("workspace B opens on its own default; A's choice is there again for A", () => {
    mount();
    choose(OFF);
    unmount();

    setDurableScope(B);
    mockScope = workspaceScope("ws-bob");
    mount();
    expect(select().value).toBe(CAMERA_ONLY);
    choose(CAMERA_AND_ORIGINAL);
    unmount();

    setDurableScope(A);
    mockScope = workspaceScope("ws-alice");
    mount();
    expect(select().value).toBe(OFF);
  });

  test("the one-day boolean shows through: old ON reads as camera photos only, old OFF as off", () => {
    localStorage.setItem(`notewise-workspace-v1/ws-alice/${LEGACY_PHOTO_DETAILS_BOOLEAN_KEY}`, "1");
    mount();
    expect(select().value).toBe(CAMERA_ONLY);
    unmount();

    localStorage.setItem(`notewise-workspace-v1/ws-alice/${LEGACY_PHOTO_DETAILS_BOOLEAN_KEY}`, "0");
    mount();
    expect(select().value).toBe(OFF);
    // Still nothing written until the user changes it.
    expect(localStorage.getItem(`notewise-workspace-v1/ws-alice/${PHOTO_DETAILS_STORAGE_KEY}`)).toBeNull();
  });

  test("it is a workspace fact: the control is not offered without a workspace session", () => {
    mockScope = null;
    mount();
    expect(select()).toBeNull();
  });
});

/* --------------- Settings keeps the DETAILED file state (2026-09-12) ------ */
//
// The top-of-app line is quiet about routine syncing; this panel is where the
// routine states are still spelled out, for visibility and troubleshooting.

describe("Settings → Workspace → Files still shows routine upload detail", () => {
  function stubAssetSync(initial) {
    let status = initial;
    const listeners = new Set();
    return {
      getStatus: () => status,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retryNow: () => {},
      push(next) {
        status = next;
        for (const listener of listeners) listener({ type: "status", ...next });
      },
    };
  }
  const filesBlock = () =>
    Array.from(host.querySelectorAll("div")).find((el) => el.textContent === "Files")?.parentElement || null;

  test("Uploading N files…, then Files synced, then Offline — waiting, then a failure with Retry", () => {
    const engine = stubAssetSync({ status: "uploading", pending: 2, failed: 0, active: 2, bytesTotal: 0, bytesDone: 0 });
    mockScope = { ...workspaceScope("ws-alice"), assetSync: engine };
    mount();
    expect(filesBlock()).not.toBeNull();
    expect(filesBlock().textContent).toMatch(/Uploading 2 files…/);

    // Real bytes reported: Settings shows the progress sentence; the panel is
    // the only surface that does.
    act(() => engine.push({ status: "uploading", pending: 1, failed: 0, active: 1, bytesTotal: 8 * 1024 * 1024, bytesDone: 3.1 * 1024 * 1024 }));
    expect(filesBlock().textContent).toMatch(/Uploading 1 file · 3\.1 MB of 8 MB/);

    act(() => engine.push({ status: "idle", pending: 0, failed: 0, active: 0, bytesTotal: 0, bytesDone: 0 }));
    expect(filesBlock().textContent).toMatch(/Files synced/);

    act(() => engine.push({ status: "offline", pending: 3, failed: 0, active: 0, bytesTotal: 0, bytesDone: 0 }));
    expect(filesBlock().textContent).toMatch(/Offline — 3 files waiting to upload\./);

    act(() => engine.push({ status: "failed", pending: 1, failed: 1, active: 0, bytesTotal: 0, bytesDone: 0, error: "unknown" }));
    expect(filesBlock().textContent).toMatch(/Retry/);
    expect(filesBlock().textContent).toMatch(/Some files could not be uploaded to your account/);
  });
});
