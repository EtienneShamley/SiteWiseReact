// src/components/AssetUploadStatus.js
//
// The one line at the top of the app about FILES and the account — and,
// since 2026-09-12, a line that appears ONLY when the user needs to know
// something.
//
// ROUTINE SYNC IS SILENT HERE. An upload beginning, bytes moving, an upload
// completing, "everything synced": none of it is shown at the top. A person
// adding an image, a PDF, an attachment or a logo to a note is working, and a
// banner announcing each successful background transfer is noise, not
// information. The full, detailed state — "Uploading 2 files…", "Files
// synced", waiting counts — is still spelled out in Settings → Workspace →
// Files (src/components/SettingsModal.js), where a person goes when they want
// to know. Both places word a state with the SAME builders, defined below.
//
// WHAT IS SHOWN, and only this:
//   OFFLINE with files waiting   "Offline — N files waiting to upload." — the
//                                files are safe on this device, and this says
//                                so; it clears by itself when the connection
//                                returns.
//   FILES NEEDING ATTENTION      automatic retries are exhausted, or refused
//                                outright: "N files need attention" with a
//                                Retry — the one state where the user has to
//                                act. The reason is the engine's own message,
//                                the same one Settings shows.
//
// It is deliberately separate from `BusyStatus`, which says a LOCAL operation
// is under way — "Processing…", "Adding image…" — and from the per-note save
// status in the editor toolbar (src/lib/saveStatus.js), which is about NOTES
// reaching the account and is not touched by this policy: a structured-data
// save failure is still shown exactly where it always was.
//
// NOTHING HERE DECIDES ANYTHING. It reads the upload engine's published
// status (src/lib/cloud/assetUploadSync.js) and, for Retry, calls the engine's
// existing `retryNow()` — the same control Settings offers. No timer, no
// polling, no second sync mechanism.

import React, { useEffect, useState } from "react";
import { ASSET_SYNC_STATUS, assetSyncFailureMessage } from "../lib/cloud/assetUploadSync";

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
 * Pure, so the wording is testable without rendering. Shown in ONE place:
 * Settings → Workspace → Files (through `assetSyncStatusLine` below) — the
 * detailed troubleshooting surface. Never at the top of the app, where
 * routine progress is not announced.
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

/* --------------------------- the shared wording -------------------------- */
/**
 * The workspace's FILE state, in one sentence (Production Readiness Phase
 * 7.4). Deliberately about files only: notes, templates and PDF entries have
 * their own line above it, and merging the two would make either one vague.
 *
 * It never says "uploading" for a queue that is merely waiting — offline, or
 * with no bucket configured — because that would tell the user their files
 * are on their way when nothing is moving.
 */
export function assetSyncStatusLine(status) {
  if (!status) return "";
  const pending = Number(status.pending) || 0;
  const failed = Number(status.failed) || 0;
  const waiting = Math.max(0, pending - failed);
  const files = (n) => `${n} ${n === 1 ? "file" : "files"}`;
  switch (status.status) {
    case ASSET_SYNC_STATUS.UNCONFIGURED:
      return "Files stay on this device — uploading files to your account is not switched on in this version.";
    case ASSET_SYNC_STATUS.OFFLINE:
      return waiting > 0
        ? `Offline — ${files(waiting)} waiting to upload.`
        : "Offline — no files are waiting to upload.";
    case ASSET_SYNC_STATUS.UPLOADING: {
      // The real-byte progress sentence, once the SDK has reported a total;
      // until then, or with nothing yet in flight, the existing wording.
      const progress = assetUploadProgressLine(status);
      if (progress && (Number(status.bytesTotal) || 0) > 0) return progress;
      return `Uploading ${files(Math.max(1, Number(status.active) || waiting || 1))}…`;
    }
    case ASSET_SYNC_STATUS.WAITING:
      return waiting > 0 ? `${files(waiting)} waiting to upload` : "Files synced";
    case ASSET_SYNC_STATUS.FAILED:
      return waiting > 0 ? `${files(waiting)} waiting to upload` : "Files synced";
    default:
      return waiting > 0 ? `${files(waiting)} waiting to upload` : "Files synced";
  }
}

/** "1 file needs attention", or "" when none does. */
export function assetSyncAttentionLine(status) {
  const failed = status ? Number(status.failed) || 0 : 0;
  if (failed <= 0) return "";
  return `${failed} ${failed === 1 ? "file needs" : "files need"} attention`;
}

/** What the top-of-app line may offer. */
export const ASSET_ATTENTION_KIND = Object.freeze({ OFFLINE: "offline", ATTENTION: "attention" });

export const RETRY_UPLOADS_LABEL = "Retry";

/**
 * The ONE thing worth saying at the top of the app about files, or null.
 *
 *   { kind: "offline",   text }               files are waiting for a connection
 *   { kind: "attention", text, detail|null }  files need the user; Retry is offered
 *
 * Null for everything routine — unconfigured, idle, uploading, and a queue
 * merely waiting between automatic retries — and for an offline session with
 * nothing waiting, because there is nothing to know.
 */
export function assetUploadAttention(status) {
  if (!status) return null;
  const failed = Number(status.failed) || 0;
  if (failed > 0) {
    return {
      kind: ASSET_ATTENTION_KIND.ATTENTION,
      text: assetSyncAttentionLine(status),
      detail: status.error ? assetSyncFailureMessage(status.error) : null,
    };
  }
  if (status.status === ASSET_SYNC_STATUS.OFFLINE) {
    const waiting = Math.max(0, (Number(status.pending) || 0) - failed);
    if (waiting <= 0) return null;
    return { kind: ASSET_ATTENTION_KIND.OFFLINE, text: assetSyncStatusLine(status), detail: null };
  }
  return null;
}

export default function AssetUploadStatus({ assetSync, className = "" }) {
  const status = useAssetUploadStatus(assetSync);
  const attention = assetUploadAttention(status);
  if (!attention) return null;
  const needsUser = attention.kind === ASSET_ATTENTION_KIND.ATTENTION;
  return (
    <span
      // A failure the user must act on is announced; an offline wait is not
      // interrupted into — it clears by itself.
      role={needsUser ? "alert" : "status"}
      aria-live={needsUser ? "assertive" : "polite"}
      data-asset-upload-status={attention.kind}
      title={attention.detail || undefined}
      className={[
        "inline-flex items-center gap-1 text-xs",
        needsUser ? "text-amber-700 dark:text-amber-300" : "text-gray-500 dark:text-gray-400",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span>{attention.text}</span>
      {needsUser && assetSync && typeof assetSync.retryNow === "function" && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="underline" onClick={() => assetSync.retryNow()}>
            {RETRY_UPLOADS_LABEL}
          </button>
        </>
      )}
    </span>
  );
}
