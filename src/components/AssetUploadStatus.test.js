// src/components/AssetUploadStatus.test.js
//
// The inline "files are leaving this device" line (Production Readiness Phase
// 7.4). The property that matters is what it does NOT say: a queue that is
// waiting for a connection, or one that cannot be uploaded at all because
// this build has no bucket, must never read as "Uploading…".

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import AssetUploadStatus, {
  assetUploadProgressLine,
  formatUploadBytes,
} from "./AssetUploadStatus";
import { ASSET_SYNC_STATUS } from "../lib/cloud/assetUploadSync";

/** A minimal engine-shaped stub: a status plus a subscription. */
function stubEngine(initial) {
  let status = initial;
  const listeners = new Set();
  return {
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

describe("<AssetUploadStatus />", () => {
  test("renders nothing without an engine", () => {
    const view = render(<AssetUploadStatus assetSync={null} />);
    expect(view.container.textContent).toBe("");
    view.unmount();
  });

  test("renders nothing while the queue merely waits", () => {
    const engine = stubEngine({ status: ASSET_SYNC_STATUS.WAITING, pending: 4, active: 0, bytesTotal: 0, bytesDone: 0 });
    const view = render(<AssetUploadStatus assetSync={engine} />);
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector("[data-asset-upload-status]")).toBeNull();
    view.unmount();
  });

  test("appears and updates as real bytes move, in a polite live region", () => {
    const engine = stubEngine({ status: ASSET_SYNC_STATUS.IDLE, pending: 0, active: 0, bytesTotal: 0, bytesDone: 0 });
    const view = render(<AssetUploadStatus assetSync={engine} />);
    expect(view.container.textContent).toBe("");

    act(() => {
      engine.push({
        status: ASSET_SYNC_STATUS.UPLOADING,
        pending: 1,
        active: 1,
        bytesTotal: 2 * 1024 * 1024,
        bytesDone: 0,
      });
    });
    const region = view.container.querySelector("[data-asset-upload-status]");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("Uploading 1 file · 0 bytes of 2 MB");
    expect(region.querySelector("[data-busy-spinner]").getAttribute("aria-hidden")).toBe("true");

    act(() => {
      engine.push({
        status: ASSET_SYNC_STATUS.UPLOADING,
        pending: 1,
        active: 1,
        bytesTotal: 2 * 1024 * 1024,
        bytesDone: 1024 * 1024,
      });
    });
    expect(view.container.textContent).toBe("Uploading 1 file · 1 MB of 2 MB");

    act(() => {
      engine.push({ status: ASSET_SYNC_STATUS.IDLE, pending: 0, active: 0, bytesTotal: 0, bytesDone: 0 });
    });
    expect(view.container.textContent).toBe("");
    view.unmount();
  });

  test("never says 'Uploading' for an unconfigured build", () => {
    const engine = stubEngine({
      status: ASSET_SYNC_STATUS.UNCONFIGURED,
      pending: 7,
      active: 0,
      bytesTotal: 0,
      bytesDone: 0,
    });
    const view = render(<AssetUploadStatus assetSync={engine} />);
    expect(view.container.textContent).not.toMatch(/upload/i);
    view.unmount();
  });
});
