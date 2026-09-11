// src/components/AssetUploadStatus.test.js
//
// The top-of-app line about files (Production Readiness Phase 7.4; policy
// inverted 2026-09-12). What matters most is what it does NOT say: routine,
// successful background syncing — an upload starting, bytes moving, an
// upload finishing, "synced" — is silent here. It speaks only when the user
// needs to know: offline with files waiting, or files that need attention,
// with the engine's own Retry. The detailed routine state lives in Settings.

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import AssetUploadStatus, {
  ASSET_ATTENTION_KIND,
  RETRY_UPLOADS_LABEL,
  assetSyncAttentionLine,
  assetSyncStatusLine,
  assetUploadAttention,
  assetUploadProgressLine,
  formatUploadBytes,
} from "./AssetUploadStatus";
import { RETRY_UPLOADS_LABEL as SETTINGS_RETRY_LABEL } from "./SettingsModal";
import { ASSET_SYNC_STATUS } from "../lib/cloud/assetUploadSync";

/** A minimal engine-shaped stub: a status plus a subscription. */
function stubEngine(initial) {
  let status = initial;
  const listeners = new Set();
  return {
    retries: 0,
    retryNow() {
      this.retries += 1;
    },
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(next) {
      status = next;
      for (const listener of listeners) listener({ type: "status", ...next });
    },
  };
}

function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    update: (next) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

describe("formatUploadBytes", () => {
  test("uses the scale a person reads, and never a negative or nonsense value", () => {
    expect(formatUploadBytes(0)).toBe("0 bytes");
    expect(formatUploadBytes(1)).toBe("1 byte");
    expect(formatUploadBytes(940)).toBe("940 bytes");
    expect(formatUploadBytes(1024)).toBe("1 KB");
    expect(formatUploadBytes(832000)).toBe("813 KB");
    expect(formatUploadBytes(3.1 * 1024 * 1024)).toBe("3.1 MB");
    expect(formatUploadBytes(8 * 1024 * 1024)).toBe("8 MB");
    expect(formatUploadBytes(64 * 1024 * 1024)).toBe("64 MB");
    expect(formatUploadBytes(-5)).toBe("0 bytes");
    expect(formatUploadBytes(undefined)).toBe("0 bytes");
  });
});

describe("assetUploadProgressLine", () => {
  test("names the files and the REAL bytes", () => {
    expect(
      assetUploadProgressLine({
        status: ASSET_SYNC_STATUS.UPLOADING,
        active: 2,
        bytesDone: 3.1 * 1024 * 1024,
        bytesTotal: 8 * 1024 * 1024,
      })
    ).toBe("Uploading 2 files · 3.1 MB of 8 MB");
  });

  test("is singular for one file", () => {
    expect(
      assetUploadProgressLine({ status: ASSET_SYNC_STATUS.UPLOADING, active: 1, bytesDone: 0, bytesTotal: 1024 })
    ).toBe("Uploading 1 file · 0 bytes of 1 KB");
  });

  test("omits the byte clause rather than inventing one when no total is known yet", () => {
    expect(
      assetUploadProgressLine({ status: ASSET_SYNC_STATUS.UPLOADING, active: 1, bytesDone: 0, bytesTotal: 0 })
    ).toBe("Uploading 1 file");
  });

  test.each([
    ASSET_SYNC_STATUS.IDLE,
    ASSET_SYNC_STATUS.OFFLINE,
    ASSET_SYNC_STATUS.WAITING,
    ASSET_SYNC_STATUS.FAILED,
    ASSET_SYNC_STATUS.UNCONFIGURED,
  ])("says nothing at all when the status is %s", (status) => {
    expect(assetUploadProgressLine({ status, active: 0, pending: 3, bytesTotal: 500, bytesDone: 0 })).toBeNull();
  });

  test("says nothing when nothing is actually in flight", () => {
    expect(
      assetUploadProgressLine({ status: ASSET_SYNC_STATUS.UPLOADING, active: 0, bytesTotal: 500, bytesDone: 0 })
    ).toBeNull();
    expect(assetUploadProgressLine(null)).toBeNull();
  });
});

const quiet = (status, extra = {}) => ({ status, pending: 0, failed: 0, active: 0, bytesTotal: 0, bytesDone: 0, ...extra });
const region = (view) => view.container.querySelector("[data-asset-upload-status]");

describe("assetUploadAttention (pure)", () => {
  test("routine states say nothing: unconfigured, idle, uploading, waiting", () => {
    expect(assetUploadAttention(null)).toBeNull();
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.UNCONFIGURED, { pending: 7 }))).toBeNull();
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.IDLE))).toBeNull();
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 2, active: 2, bytesTotal: 9, bytesDone: 1 }))).toBeNull();
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.WAITING, { pending: 3 }))).toBeNull();
  });

  test("offline with files waiting is worth knowing; offline with nothing waiting is not", () => {
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.OFFLINE, { pending: 3 }))).toEqual({
      kind: ASSET_ATTENTION_KIND.OFFLINE,
      text: "Offline — 3 files waiting to upload.",
      detail: null,
    });
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.OFFLINE, { pending: 1 })).text).toBe("Offline — 1 file waiting to upload.");
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.OFFLINE))).toBeNull();
  });

  test("files needing attention are always shown, in whichever status they occur, with the engine's reason", () => {
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.FAILED, { pending: 2, failed: 2, error: "resource-exhausted" }))).toEqual({
      kind: ASSET_ATTENTION_KIND.ATTENTION,
      text: "2 files need attention",
      detail: "Your account's file storage is full. Your files stay on this device until there is room.",
    });
    // Some failed, some still retrying automatically: the failed ones still need the user.
    expect(assetUploadAttention(quiet(ASSET_SYNC_STATUS.WAITING, { pending: 3, failed: 1 }))).toMatchObject({
      kind: ASSET_ATTENTION_KIND.ATTENTION,
      text: "1 file needs attention",
      detail: null,
    });
  });
});

describe("the shared wording Settings and the top line both use", () => {
  test("assetSyncStatusLine spells out every routine state, in Settings' words", () => {
    expect(assetSyncStatusLine(quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 2, active: 2 }))).toBe("Uploading 2 files…");
    expect(assetSyncStatusLine(quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 1, active: 1 }))).toBe("Uploading 1 file…");
    // Once the SDK reports a total, Settings shows the REAL-byte sentence —
    // the one place `assetUploadProgressLine` is rendered.
    const moving = quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 1, active: 1, bytesTotal: 2 * 1024 * 1024, bytesDone: 1024 * 1024 });
    expect(assetSyncStatusLine(moving)).toBe("Uploading 1 file · 1 MB of 2 MB");
    expect(assetSyncStatusLine(moving)).toBe(assetUploadProgressLine(moving));
    // …and the top-of-app line is still silent for exactly that state.
    expect(assetUploadAttention(moving)).toBeNull();
    expect(assetSyncStatusLine(quiet(ASSET_SYNC_STATUS.IDLE))).toBe("Files synced");
    expect(assetSyncStatusLine(quiet(ASSET_SYNC_STATUS.WAITING, { pending: 4 }))).toBe("4 files waiting to upload");
    expect(assetSyncStatusLine(quiet(ASSET_SYNC_STATUS.OFFLINE, { pending: 2 }))).toBe("Offline — 2 files waiting to upload.");
    expect(assetSyncStatusLine(quiet(ASSET_SYNC_STATUS.OFFLINE))).toBe("Offline — no files are waiting to upload.");
    expect(assetSyncStatusLine(quiet(ASSET_SYNC_STATUS.UNCONFIGURED, { pending: 5 }))).toMatch(/Files stay on this device/);
    expect(assetSyncStatusLine(null)).toBe("");
  });

  test("assetSyncAttentionLine counts what needs the user, and the Retry label is one string in both places", () => {
    expect(assetSyncAttentionLine(quiet(ASSET_SYNC_STATUS.FAILED, { pending: 2, failed: 2 }))).toBe("2 files need attention");
    expect(assetSyncAttentionLine(quiet(ASSET_SYNC_STATUS.WAITING, { pending: 2, failed: 1 }))).toBe("1 file needs attention");
    expect(assetSyncAttentionLine(quiet(ASSET_SYNC_STATUS.IDLE))).toBe("");
    expect(RETRY_UPLOADS_LABEL).toBe(SETTINGS_RETRY_LABEL);
  });
});

describe("<AssetUploadStatus /> — quiet about routine syncing, present when it matters", () => {
  test("renders nothing without an engine", () => {
    const view = render(<AssetUploadStatus assetSync={null} />);
    expect(view.container.textContent).toBe("");
    view.unmount();
  });

  test("1. a normal upload in progress produces NO top-of-app line, however the bytes move", () => {
    const engine = stubEngine(quiet(ASSET_SYNC_STATUS.IDLE));
    const view = render(<AssetUploadStatus assetSync={engine} />);
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 1, active: 1, bytesTotal: 2 * 1024 * 1024, bytesDone: 0 })));
    expect(region(view)).toBeNull();
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 1, active: 1, bytesTotal: 2 * 1024 * 1024, bytesDone: 1024 * 1024 })));
    expect(region(view)).toBeNull();
    expect(view.container.textContent).toBe("");
    view.unmount();
  });

  test("2. success — the upload completes and everything is synced — produces NO top-of-app line", () => {
    const engine = stubEngine(quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 1, active: 1 }));
    const view = render(<AssetUploadStatus assetSync={engine} />);
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.IDLE)));
    expect(region(view)).toBeNull();
    expect(view.container.textContent).toBe("");
    view.unmount();
  });

  test("a queue merely waiting between automatic retries is silent, and so is an unconfigured build", () => {
    const waiting = stubEngine(quiet(ASSET_SYNC_STATUS.WAITING, { pending: 4 }));
    const a = render(<AssetUploadStatus assetSync={waiting} />);
    expect(region(a)).toBeNull();
    a.unmount();
    const none = stubEngine(quiet(ASSET_SYNC_STATUS.UNCONFIGURED, { pending: 7 }));
    const b = render(<AssetUploadStatus assetSync={none} />);
    expect(b.container.textContent).toBe("");
    b.unmount();
  });

  test("3. offline with files waiting IS shown — politely — and clears by itself when the connection returns", () => {
    const engine = stubEngine(quiet(ASSET_SYNC_STATUS.IDLE));
    const view = render(<AssetUploadStatus assetSync={engine} />);
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.OFFLINE, { pending: 2 })));
    const el = region(view);
    expect(el).not.toBeNull();
    expect(el.getAttribute("data-asset-upload-status")).toBe(ASSET_ATTENTION_KIND.OFFLINE);
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.textContent).toBe("Offline — 2 files waiting to upload.");
    expect(el.querySelector("button")).toBeNull(); // nothing to do but wait
    // Back online, the engine drains: the line goes away without any click.
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.UPLOADING, { pending: 2, active: 2 })));
    expect(region(view)).toBeNull();
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.IDLE)));
    expect(region(view)).toBeNull();
    view.unmount();
  });

  test("offline with NOTHING waiting shows nothing — there is nothing to know", () => {
    const engine = stubEngine(quiet(ASSET_SYNC_STATUS.OFFLINE));
    const view = render(<AssetUploadStatus assetSync={engine} />);
    expect(region(view)).toBeNull();
    view.unmount();
  });

  test("4. an actual upload failure IS shown — as an alert, with the reason and a Retry that reaches the engine", () => {
    const engine = stubEngine(quiet(ASSET_SYNC_STATUS.IDLE));
    const view = render(<AssetUploadStatus assetSync={engine} />);
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.FAILED, { pending: 1, failed: 1, error: "storage/quota-exceeded" })));
    const el = region(view);
    expect(el).not.toBeNull();
    expect(el.getAttribute("data-asset-upload-status")).toBe(ASSET_ATTENTION_KIND.ATTENTION);
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.textContent).toMatch(/^1 file needs attention/);
    expect(el.getAttribute("title")).toMatch(/file storage is full/);
    const retry = el.querySelector("button");
    expect(retry.textContent).toBe(RETRY_UPLOADS_LABEL);
    act(() => retry.click());
    expect(engine.retries).toBe(1); // the engine's own retryNow, nothing else

    // Retry succeeded: the line clears.
    act(() => engine.push(quiet(ASSET_SYNC_STATUS.IDLE)));
    expect(region(view)).toBeNull();
    view.unmount();
  });

  test("files needing attention while others still retry automatically are shown too", () => {
    const engine = stubEngine(quiet(ASSET_SYNC_STATUS.WAITING, { pending: 3, failed: 2 }));
    const view = render(<AssetUploadStatus assetSync={engine} />);
    expect(region(view).textContent).toMatch(/^2 files need attention/);
    view.unmount();
  });
});
