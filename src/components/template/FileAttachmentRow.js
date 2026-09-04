// src/components/template/FileAttachmentRow.js
//
// One file of a File field: a compact document row showing filename, basic
// type and human-readable size, with Open/Preview / Download / Remove actions.
// The binary lives only in IndexedDB; object URLs are created on demand and
// revoked through an owned lifecycle — `blob:` URLs are never persisted.
//
// SECURITY: whether a file may be rendered inline is decided ONLY by the MIME
// type of the Blob retrieved from IndexedDB, via the shared allowlist policy in
// src/lib/safeAttachmentOpen.js. The filename, its extension and the displayed
// type label carry NO permission — a `report.txt` whose stored Blob is
// text/html is Download-only. The policy is evaluated twice: once after the
// asset is loaded (so the row shows the correct action) and again against the
// freshly retrieved Blob at click time (the authoritative check, so a record
// that changed underneath us cannot be rendered inline).
//
// Because that retrieval is asynchronous, a PDF's new tab is reserved
// synchronously in the click handler and navigated once the Blob arrives — see
// safeAttachmentOpen.js. A blocked-popup error is reported ONLY when a tab
// genuinely could not be opened.
//
// Office formats (DOC/DOCX/XLS/XLSX) are Download-only — NoteWise does not
// preview Office content.
//
// CROSS-DEVICE (Production Readiness Phase 7.5). The bytes may live only in
// the workspace's cloud copy; the shared read boundary downloads and caches
// them on demand through the same call this row has always made. The row now
// distinguishes downloading / not-yet-available / offline from "gone", offers
// Retry where one can help, and refuses Open and Download until the bytes are
// actually here — the open policy is decided from the Blob retrieved, and
// there is no Blob to decide from before then.
//
// Messages here are FIXED and restrained: they never carry an exception
// message, a storage detail or an object URL. Raw exception text is not
// something a user can act on, and showing it only describes how the
// application is built. The download filename goes through the shared
// safeDownloadFilename helper, so Template-form evidence and Free-form note
// attachments cannot hold different ideas of what a safe filename is.
import React, { useEffect, useRef, useState } from "react";
import { ASSET_READ_STATE, loadAsset, readAssetWithState } from "../../lib/assetReader";
import {
  ASSET_READ_SURFACE,
  RETRY_ASSET_READ_LABEL,
  assetReadMessage,
  isBusyAssetRead,
  isRecoverableAssetRead,
  isRetryableAssetRead,
} from "../../lib/assetReadPresentation";
import { formatFileSize, fileKindLabel } from "../../lib/noteAttachments";
import {
  RENDER_MODE,
  OPEN_RESULT,
  NAVIGATION_URL_REVOKE_MS,
  ATTACHMENT_DOWNLOAD_FAILED_MESSAGE,
  ATTACHMENT_OPEN_FAILED_MESSAGE,
  ATTACHMENT_PREVIEW_DENIED_MESSAGE,
  ATTACHMENT_UNAVAILABLE_MESSAGE,
  resolveOpenPolicy,
  isInlineRenderable,
  createManagedObjectUrl,
  reserveNavigationTab,
  openAttachmentSafely,
  safeDownloadFilename,
} from "../../lib/safeAttachmentOpen";
import PhotoPreviewDialog from "./PhotoPreviewDialog";
import TextPreviewDialog from "./TextPreviewDialog";

export default function FileAttachmentRow({
  attachment,
  // () => void. Remove is offered ONLY when a handler is supplied: a caller
  // that can delete this file passes one, a caller that cannot passes none.
  // Deciding it by the handler rather than by a display mode is what stops a
  // Remove button appearing that would do nothing, or — worse — be wired to a
  // different collection than the one on screen. Open/Preview and Download are
  // always available: both are inherently read-only and change nothing
  // persisted.
  onRemove,
  onError, // (message) => void
}) {
  // status: the SHARED read state (src/lib/assetReader.js); `ready` is the
  // only one that permits an action.
  // policy: derived from the stored Blob's own MIME type (never the filename).
  const [state, setState] = useState({ status: ASSET_READ_STATE.LOADING, code: null, policy: null });
  // Bumped by Retry; re-runs the read as a genuinely fresh attempt (nothing
  // is cached between reads, and remote metadata is always current).
  const [attempt, setAttempt] = useState(0);
  // Active controlled preview: { kind: "image", url, revoke } | { kind: "text", blob }
  const [preview, setPreview] = useState(null);

  const name = attachment.name || "Attached file";

  useEffect(() => {
    let cancelled = false;
    setState({ status: ASSET_READ_STATE.LOADING, code: null, policy: null });
    readAssetWithState(attachment.assetId, {
      onState: (phase) => {
        if (cancelled) return;
        setState((prev) => (prev.policy ? prev : { ...prev, status: phase }));
      },
    })
      .then(({ state: status, code, record }) => {
        if (cancelled) return;
        if (status !== ASSET_READ_STATE.READY || !record || !record.blob) {
          setState({
            status: status === ASSET_READ_STATE.READY ? ASSET_READ_STATE.MISSING : status,
            code: code || null,
            policy: null,
          });
          return;
        }
        setState({
          status: ASSET_READ_STATE.READY,
          code: null,
          policy: resolveOpenPolicy(record.blob.type, attachment.mimeType),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: ASSET_READ_STATE.ERROR, code: null, policy: null });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.assetId, attachment.mimeType, attempt]);

  // Object-URL ownership: revoked explicitly on close, and on unmount via a ref
  // so an open preview can never leak. Keyed on nothing, so re-running effects
  // (e.g. under StrictMode) can never revoke a URL that is still in use.
  const previewRef = useRef(null);
  previewRef.current = preview;
  useEffect(() => {
    return () => {
      if (previewRef.current && previewRef.current.revoke) {
        previewRef.current.revoke();
      }
    };
  }, []);

  function closePreview() {
    if (preview && preview.revoke) preview.revoke();
    setPreview(null);
  }

  // Click entry point. A PDF opens in a new tab, but the Blob is retrieved
  // asynchronously — so the tab is reserved HERE, synchronously, while the
  // click's user activation is still valid. Anything else is a dialog and
  // needs no tab.
  function handleOpenClick() {
    const needsTab = state.policy?.mode === RENDER_MODE.PDF;
    const reservedTab = needsTab ? reserveNavigationTab() : null;
    if (needsTab && !reservedTab) {
      // The only genuine block: the browser refused the tab up front.
      onError && onError(ATTACHMENT_OPEN_FAILED_MESSAGE);
      return;
    }
    handleOpen(reservedTab);
  }

  // Authoritative open path: re-read the asset and re-evaluate the policy
  // against the Blob we actually hold before presenting anything inline.
  async function handleOpen(reservedTab) {
    const result = await openAttachmentSafely({
      reservedTab,
      metadataMimeType: attachment.mimeType,
      getBlob: async () => {
        const asset = await loadAsset(attachment.assetId);
        return asset?.blob || null;
      },
    });

    if (result.policy) setState({ status: ASSET_READ_STATE.READY, code: null, policy: result.policy });

    switch (result.status) {
      case OPEN_RESULT.READ_ERROR:
        onError && onError(ATTACHMENT_OPEN_FAILED_MESSAGE);
        return;
      case OPEN_RESULT.MISSING:
        setState({ status: ASSET_READ_STATE.MISSING, code: null, policy: null });
        onError && onError(ATTACHMENT_UNAVAILABLE_MESSAGE);
        return;
      case OPEN_RESULT.DENIED:
        // Denial never mutates or removes the attachment — it stays downloadable.
        onError && onError(ATTACHMENT_PREVIEW_DENIED_MESSAGE);
        return;
      case OPEN_RESULT.BLOCKED:
        onError && onError(ATTACHMENT_OPEN_FAILED_MESSAGE);
        return;
      case OPEN_RESULT.IMAGE_PREVIEW:
        setPreview({ kind: "image", url: result.url, revoke: result.revoke });
        return;
      case OPEN_RESULT.TEXT_PREVIEW:
        // Read through blob.text() in the dialog and render escaped — no object
        // URL, no navigation.
        setPreview({ kind: "text", blob: result.blob });
        return;
      default:
        // PDF opened successfully — nothing to show, and no error.
        return;
    }
  }

  async function handleDownload() {
    let asset;
    try {
      asset = await loadAsset(attachment.assetId);
    } catch {
      onError && onError(ATTACHMENT_DOWNLOAD_FAILED_MESSAGE);
      return;
    }
    if (!asset || !asset.blob) {
      setState({ status: ASSET_READ_STATE.MISSING, code: null, policy: null });
      onError && onError(ATTACHMENT_UNAVAILABLE_MESSAGE);
      return;
    }
    try {
      // `download` saves the file rather than rendering it, so this is safe for
      // every type — including those refused inline above.
      const managed = createManagedObjectUrl(asset.blob, {
        revokeAfterMs: NAVIGATION_URL_REVOKE_MS,
      });
      const a = document.createElement("a");
      a.href = managed.url;
      // Sanitized: a filename is user-controlled data reaching a real
      // filesystem, and it grants no permission of any kind.
      a.download = safeDownloadFilename(attachment.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      onError && onError(ATTACHMENT_DOWNLOAD_FAILED_MESSAGE);
    }
  }

  const ready = state.status === ASSET_READ_STATE.READY;
  const busy = isBusyAssetRead(state.status);
  // Recoverable is not available: the bytes may yet arrive, and until they do
  // no action may be offered — but the row must not claim the file is gone.
  const pendingRemote = !ready && isRecoverableAssetRead(state.status);
  const unavailable = !ready && !busy && !pendingRemote;
  const stateMessage = ready
    ? null
    : assetReadMessage({ state: state.status, code: state.code, surface: ASSET_READ_SURFACE.FILE });
  const canOpen = ready && isInlineRenderable(state.policy);
  // Label the action for what it actually does.
  const openLabel = state.policy?.mode === RENDER_MODE.PDF ? "Open" : "Preview";

  return (
    <div
      className={`file-att-row ${unavailable ? "file-att-row--missing" : ""}`}
      data-attachment-state={state.status}
    >
      <span className="file-att-name" title={name}>
        {name}
      </span>
      <span className="file-att-meta">
        {/* Display label only — it grants no rendering permission. */}
        {fileKindLabel(attachment.mimeType, attachment.name)}
        {attachment.size > 0 ? ` · ${formatFileSize(attachment.size)}` : ""}
        {unavailable ? " · unavailable — its stored file could not be found" : ""}
        {!ready && !unavailable && stateMessage ? ` · ${stateMessage}` : ""}
      </span>
      <span className="file-att-actions">
        {canOpen && (
          <button
            type="button"
            className="file-att-btn"
            aria-label={`${openLabel} ${name}`}
            onClick={handleOpenClick}
          >
            {openLabel}
          </button>
        )}
        <button
          type="button"
          className="file-att-btn"
          aria-label={`Download ${name}`}
          onClick={handleDownload}
          disabled={!ready}
        >
          Download
        </button>
        {isRetryableAssetRead(state.status) && (
          <button
            type="button"
            className="file-att-btn"
            aria-label={`${RETRY_ASSET_READ_LABEL} loading ${name}`}
            onClick={() => setAttempt((n) => n + 1)}
          >
            {RETRY_ASSET_READ_LABEL}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="file-att-btn file-att-btn--danger"
            aria-label={`Remove file ${name}`}
            onClick={onRemove}
          >
            Remove
          </button>
        )}
      </span>

      {preview?.kind === "image" && (
        <PhotoPreviewDialog url={preview.url} name={name} onClose={closePreview} />
      )}
      {preview?.kind === "text" && (
        <TextPreviewDialog blob={preview.blob} name={name} onClose={closePreview} />
      )}
    </div>
  );
}
