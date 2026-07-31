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
// Office formats (DOC/DOCX/XLS/XLSX) are Download-only — NoteWise does not
// preview Office content.
import React, { useEffect, useRef, useState } from "react";
import { getAsset } from "../../lib/assetStorage";
import { formatFileSize, fileKindLabel } from "../../lib/noteAttachments";
import {
  RENDER_MODE,
  resolveOpenPolicy,
  isInlineRenderable,
  createManagedObjectUrl,
} from "../../lib/safeAttachmentOpen";
import PhotoPreviewDialog from "./PhotoPreviewDialog";
import TextPreviewDialog from "./TextPreviewDialog";

// A navigated PDF needs its URL to outlive the click; the new tab reads it
// immediately after opening. Mirrors the exported-file handling elsewhere.
const NAVIGATION_URL_REVOKE_MS = 10000;

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

  // Authoritative open path: re-read the asset and re-evaluate the policy
  // against the Blob we actually hold before presenting anything inline.
  async function handleOpen() {
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

    const policy = resolveOpenPolicy(asset.blob.type, attachment.mimeType);
    setState({ available: true, policy });

    if (!isInlineRenderable(policy)) {
      // Denial never mutates or removes the attachment — it stays downloadable.
      onError &&
        onError(
          `"${name}" can't be previewed safely in NoteWise. Use Download to open it in another application.`
        );
      return;
    }

    if (policy.mode === RENDER_MODE.PDF) {
      const managed = createManagedObjectUrl(asset.blob, {
        revokeAfterMs: NAVIGATION_URL_REVOKE_MS,
      });
      const win = window.open(managed.url, "_blank", "noopener");
      if (!win) {
        managed.revoke();
        onError && onError(`The browser blocked opening "${name}".`);
      }
      return;
    }

    if (policy.mode === RENDER_MODE.IMAGE) {
      const managed = createManagedObjectUrl(asset.blob);
      setPreview({ kind: "image", url: managed.url, revoke: managed.revoke });
      return;
    }

    if (policy.mode === RENDER_MODE.TEXT) {
      // Read through blob.text() in the dialog and render escaped — no object
      // URL, no navigation.
      setPreview({ kind: "text", blob: asset.blob });
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
            onClick={handleOpen}
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
