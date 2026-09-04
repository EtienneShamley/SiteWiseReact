// src/components/AssetUploadStatus.js
//
// The one inline report that FILES are being sent to the account
// (Production Readiness Phase 7.4).
//
// It is deliberately separate from `BusyStatus`, which says a local operation
// is under way — "Processing image…", "Adding image…". Those describe work on
// this device and remain exactly as they are; this describes bytes leaving it,
// and it may only appear while bytes are actually moving.
//
// REAL BYTES ONLY. The sentence is built from the engine's own
// `bytesDone` / `bytesTotal`, which come from the Storage SDK's resumable
// upload counters (src/lib/cloud/firebaseStorageAdapter.js). Nothing here
// interpolates, estimates or animates a percentage.
//
// SILENT WHEN NOTHING IS UPLOADING. A queue waiting for a connection, or one
// that cannot be uploaded because this build has no bucket, must never read
// as "Uploading…" — that would tell the user their files are on their way
// when they are not. Those states are reported where they belong: in
// Settings, in words (src/components/SettingsModal.js).

import React, { useEffect, useState } from "react";
import { BusySpinner } from "./BusyStatus";
import { ASSET_SYNC_STATUS } from "../lib/cloud/assetUploadSync";

/** "3.1 MB", "812 KB", "940 bytes" — the same scale the file cards use. */
export function formatUploadBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "0 bytes";
  if (n < 1024) return `${Math.round(n)} ${Math.round(n) === 1 ? "byte" : "bytes"}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * "Uploading 2 files · 3.1 MB of 8 MB", or null when nothing is uploading.
 * Pure, so the wording is testable without rendering.
 */
export function assetUploadProgressLine(status) {
  if (!status || status.status !== ASSET_SYNC_STATUS.UPLOADING) return null;
  const active = Number(status.active) || 0;
  if (active <= 0) return null;
  const files = `Uploading ${active} ${active === 1 ? "file" : "files"}`;
  const total = Number(status.bytesTotal) || 0;
  if (total <= 0) return files;
  return `${files} · ${formatUploadBytes(Number(status.bytesDone) || 0)} of ${formatUploadBytes(total)}`;
}

/** Subscribes to one upload engine's status. Null-safe: no engine, no status. */
export function useAssetUploadStatus(assetSync) {
  const [status, setStatus] = useState(() => (assetSync ? assetSync.getStatus() : null));
  useEffect(() => {
    if (!assetSync) {
      setStatus(null);
      return undefined;
    }
    setStatus(assetSync.getStatus());
    return assetSync.subscribe((event) => {
      if (event.type === "status") setStatus(assetSync.getStatus());
    });
  }, [assetSync]);
  return status;
}

export default function AssetUploadStatus({ assetSync, className = "" }) {
  const status = useAssetUploadStatus(assetSync);
  const line = assetUploadProgressLine(status);
  if (!line) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      data-asset-upload-status=""
      className={["inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400", className]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Decorative; the words carry the meaning. */}
      <BusySpinner />
      <span>{line}</span>
    </span>
  );
}
