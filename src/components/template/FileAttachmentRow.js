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
import React, { useEffect, useRef, useState } from "react";
import { getAsset } from "../../lib/assetStorage";
import { formatFileSize, fileKindLabel } from "../../lib/noteAttachments";
import {
  RENDER_MODE,
  OPEN_RESULT,
  NAVIGATION_URL_REVOKE_MS,
  resolveOpenPolicy,
  isInlineRenderable,
  createManagedObjectUrl,
  reserveNavigationTab,
  openAttachmentSafely,
} from "../../lib/safeAttachmentOpen";
import PhotoPreviewDialog from "./PhotoPreviewDialog";
import TextPreviewDialog from "./TextPreviewDialog";

export default function FileAttachmentRow({
  attachment,
  onRemove, // () => void
  onError, // (message) => void
}) {
  // available: null = still checking, true/false once resolved.
  // policy: derived from the stored Blob's own MIME type (never the filename).
  const [state, setState] = useState({ available: null, policy: null });
  // Active controlled preview: { kind: "image", url, revoke } | { kind: "text", blob }
  const [preview, setPreview] = useState(null);

  const name = attachment.name || "Attached file";

  useEffect(() => {
    let cancelled = false;
    getAsset(attachment.assetId)
      .then((asset) => {
        if (cancelled) return;
        if (!asset || !asset.blob) {
          setState({ available: false, policy: null });
          return;
        }
        setState({
          available: true,
          policy: resolveOpenPolicy(asset.blob.type, attachment.mimeType),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ available: false, policy: null });
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.assetId, attachment.mimeType]);

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
      onError && onError(`The browser blocked opening "${name}".`);
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
        const asset = await getAsset(attachment.assetId);
        return asset?.blob || null;
      },
    });

    if (result.policy) setState({ available: true, policy: result.policy });

    switch (result.status) {
      case OPEN_RESULT.READ_ERROR:
        onError &&
          onError(
            `Could not read "${name}": ${result.error?.message || result.error}`
          );
        return;
      case OPEN_RESULT.MISSING:
        setState({ available: false, policy: null });
        onError && onError(`"${name}" is missing from storage.`);
        return;
      case OPEN_RESULT.DENIED:
        // Denial never mutates or removes the attachment — it stays downloadable.
        onError &&
          onError(
            `"${name}" can't be previewed safely in NoteWise. Use Download to open it in another application.`
          );
        return;
      case OPEN_RESULT.BLOCKED:
        onError && onError(`The browser blocked opening "${name}".`);
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
      asset = await getAsset(attachment.assetId);
    } catch (err) {
      onError && onError(`Could not read "${name}": ${err?.message || err}`);
      return;
    }
    if (!asset || !asset.blob) {
      setState({ available: false, policy: null });
      onError && onError(`"${name}" is missing from storage.`);
      return;
    }
    // `download` saves the file rather than rendering it, so this is safe for
    // every type — including those refused inline above.
    const managed = createManagedObjectUrl(asset.blob, {
      revokeAfterMs: NAVIGATION_URL_REVOKE_MS,
    });
    const a = document.createElement("a");
    a.href = managed.url;
    a.download = attachment.name || "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const unavailable = state.available === false;
  const canOpen = isInlineRenderable(state.policy);
  // Label the action for what it actually does.
  const openLabel = state.policy?.mode === RENDER_MODE.PDF ? "Open" : "Preview";

  return (
    <div className={`file-att-row ${unavailable ? "file-att-row--missing" : ""}`}>
      <span className="file-att-name" title={name}>
        {name}
      </span>
      <span className="file-att-meta">
        {/* Display label only — it grants no rendering permission. */}
        {fileKindLabel(attachment.mimeType, attachment.name)}
        {attachment.size > 0 ? ` · ${formatFileSize(attachment.size)}` : ""}
        {unavailable ? " · unavailable — its stored file could not be found" : ""}
      </span>
      <span className="file-att-actions">
        {canOpen && !unavailable && (
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
          disabled={unavailable}
        >
          Download
        </button>
        <button
          type="button"
          className="file-att-btn file-att-btn--danger"
          aria-label={`Remove file ${name}`}
          onClick={onRemove}
        >
          Remove
        </button>
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
