// src/components/editor/fileAttachmentPresentation.js
//
// THE SHARED FILE-ATTACHMENT CARD — one presentation, one asset policy, one
// safe-open path, for every NoteWise surface that shows an attached file.
//
// It is the file counterpart of mediaImagePresentation.js, and it exists for
// the same reason: a Template Section's ACTIVE editor renders the shared
// `fileAttachment` NodeView, so the STATIC rendering of the same Section must
// be the same card — otherwise activating a Section would resize and restyle
// every file in it, and the page would move under the user. Two components
// could not be kept identical by discipline; one component cannot drift.
//
// Two consumers, and the difference between them is exactly two things:
//
//   src/components/editor/FileAttachment.js   the ProseMirror NodeView. Adds
//                                             NodeViewWrapper, the selected
//                                             state and a Remove button whose
//                                             click is `deleteNode()` — one
//                                             editor transaction, therefore one
//                                             undo step.
//   src/components/template/TemplateSectionDocView.js
//                                             the static Section document view.
//                                             Renders the same card in a plain
//                                             <div>, with no Remove.
//
// Nothing ProseMirror-specific lives here: no node, no transaction, no
// selection, no editor. Everything that DOES live here is the part that must be
// identical on both surfaces — the asset load, the display metadata, the
// open/download policy, the transient error notice and the markup.
//
// SECURITY (unchanged, and stated here because this is now where it lives):
//   - the node/segment metadata is DISPLAY data, never authority;
//   - the asset record retrieved from IndexedDB decides everything, and its
//     `kind` must be one this card was configured to accept
//     (`acceptedAssetKinds` — Free-form's `editor-file` by default, a Template
//     Section's `note-file` when configured). Kind policy and id/attribute
//     SHAPE validation stay separate concerns;
//   - whether a file may be rendered inline is decided ONLY by the MIME type of
//     the Blob actually retrieved, through src/lib/safeAttachmentOpen.js. The
//     filename, the extension, the displayed label and the serialized
//     `data-file-type` carry no permission at all;
//   - the policy is evaluated twice: once after the asset loads (so the card
//     shows the right action) and again against the freshly retrieved Blob at
//     click time, which is the authoritative check;
//   - no URL is ever taken from stored HTML and navigated to.
//
// CROSS-DEVICE (Production Readiness Phase 7.5). The bytes may live only in
// the workspace's cloud copy, in which case the shared read boundary
// downloads and caches them on demand — through exactly the same call this
// card has always made. What changes here is honesty about the wait: the card
// reports downloading / not-yet-available / offline separately from "gone",
// offers Retry where one can help, and REFUSES Open and Download until the
// bytes are genuinely here. Refusing is the safe default: the open policy is
// decided from the Blob actually retrieved, and there is no Blob to decide
// from until the download lands.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ASSET_READ_STATE, readAssetWithState } from "../../lib/assetReader";
import {
  ASSET_READ_SURFACE,
  RETRY_ASSET_READ_LABEL,
  assetReadMessage,
  isBusyAssetRead,
  isRecoverableAssetRead,
  isRetryableAssetRead,
} from "../../lib/assetReadPresentation";
import useTransientMessage from "../../hooks/useTransientMessage";
import {
  DEFAULT_FILE_ATTACHMENT_ASSET_KINDS,
  FILE_ATTACHMENT_CLASS,
  FILE_ATTACHMENT_LOADING_TEXT,
  FILE_ATTACHMENT_UNAVAILABLE_TEXT,
  PRINT_ATTACHMENT_NOTE,
  fileAttachmentLabel,
  fileAttachmentMetaText,
  isAcceptedFileAssetKind,
} from "../../lib/editorFileAttachments";
import {
  ATTACHMENT_DOWNLOAD_FAILED_MESSAGE,
  ATTACHMENT_OPEN_FAILED_MESSAGE,
  ATTACHMENT_PREVIEW_DENIED_MESSAGE,
  ATTACHMENT_UNAVAILABLE_MESSAGE,
  NAVIGATION_URL_REVOKE_MS,
  OPEN_RESULT,
  RENDER_MODE,
  createManagedObjectUrl,
  isInlineRenderable,
  openAttachmentSafely,
  reserveNavigationTab,
  resolveOpenPolicy,
  safeDownloadFilename,
} from "../../lib/safeAttachmentOpen";
import TextPreviewDialog from "../template/TextPreviewDialog";

/**
 * Retrieve the asset, report HOW the read went, and confirm the result is
 * genuinely a file attachment THIS CARD is configured to open.
 *
 * A missing asset, an unreadable one and one of a kind this card was not
 * configured to accept all present identically — in every case this surface
 * cannot open this file — but a file that is merely still ARRIVING is now a
 * distinct answer, because telling a user their document is gone while it is
 * downloading would be false.
 *
 * @returns {Promise<{ state: string, code: string|null, asset: object|null }>}
 */
export async function readFileAttachmentAsset(assetId, acceptedKinds, options = {}) {
  if (!assetId) return { state: ASSET_READ_STATE.MISSING, code: null, asset: null };
  let outcome;
  try {
    // The shared read boundary (src/lib/assetReader.js). The KIND POLICY below
    // is unchanged and still decides from the record's own stored kind.
    outcome = await readAssetWithState(assetId, options);
  } catch {
    return { state: ASSET_READ_STATE.ERROR, code: null, asset: null };
  }
  if (outcome.state !== ASSET_READ_STATE.READY) {
    return { state: outcome.state, code: outcome.code || null, asset: null };
  }
  const asset = outcome.record;
  if (!asset || !asset.blob) return { state: ASSET_READ_STATE.MISSING, code: null, asset: null };
  if (!isAcceptedFileAssetKind(asset.kind, acceptedKinds)) {
    return { state: ASSET_READ_STATE.MISSING, code: null, asset: null };
  }
  return { state: ASSET_READ_STATE.READY, code: null, asset };
}

/**
 * The Phase 7.2 shape — the asset or null — kept because the safe-open path
 * asks only "are there bytes I may open right now".
 */
export async function loadFileAttachmentAsset(assetId, acceptedKinds) {
  const { asset } = await readFileAttachmentAsset(assetId, acceptedKinds);
  return asset;
}

/**
 * The class list of a file-attachment card wrapper — assembled once so the
 * NodeView's wrapper and the static view's wrapper cannot drift.
 */
export function fileAttachmentWrapperClassNames({ missing, selected, extra } = {}) {
  return [
    FILE_ATTACHMENT_CLASS,
    missing ? `${FILE_ATTACHMENT_CLASS}--missing` : "",
    selected ? `${FILE_ATTACHMENT_CLASS}--selected` : "",
    ...(Array.isArray(extra) ? extra : extra ? [extra] : []),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * ONE attached file, presented.
 *
 * @param assetId/name/mimeType/size the reference's serialized attributes
 * @param acceptedAssetKinds         which asset-store kind(s) this surface may
 *                                   open (defaults to Free-form's `editor-file`)
 * @param selected                   NodeSelection chrome (NodeView only)
 * @param onRemove                   optional; when absent NO Remove button is
 *                                   rendered at all — which is how the static
 *                                   view is read-only without a second card
 *
 * @returns { className, ariaLabel, content } — the caller renders its own
 *          wrapper element (a NodeViewWrapper, or a plain div) around
 *          `content`. Everything inside is identical on both surfaces.
 */
export function useFileAttachmentCard({
  assetId,
  name,
  mimeType,
  size,
  acceptedAssetKinds = DEFAULT_FILE_ATTACHMENT_ASSET_KINDS,
  selected = false,
  onRemove = null,
} = {}) {
  // Serialized display metadata — used to draw the card before the asset
  // arrives, and to label the unavailable state if it never does.
  const fallbackName = safeDownloadFilename(name);

  // { status, policy, meta } where `status` is the SHARED read state
  // (src/lib/assetReader.js) and `meta` is the AUTHORITATIVE metadata read
  // back from the asset record once it resolves.
  const [state, setState] = useState({
    status: assetId ? ASSET_READ_STATE.LOADING : ASSET_READ_STATE.MISSING,
    code: null,
    policy: null,
    meta: null,
  });
  // Bumped by Retry; re-runs the read effect as a genuinely fresh attempt
  // (nothing is cached between reads, and remote metadata is always current).
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState(null);
  const notice = useTransientMessage();
  const { showError: showNoticeError, clear: clearNotice } = notice;

  // Duplicate-action protection: a second click while an open or download is
  // still resolving is ignored rather than starting a second operation.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  // Every object URL this card ever creates, so none can outlive the card.
  const managedUrlsRef = useRef([]);
  const trackUrl = useCallback((managed) => {
    managedUrlsRef.current.push(managed);
    return managed;
  }, []);

  const previewRef = useRef(null);
  previewRef.current = preview;

  useEffect(() => {
    const urls = managedUrlsRef;
    return () => {
      if (previewRef.current && previewRef.current.revoke) {
        previewRef.current.revoke();
      }
      for (const managed of urls.current) {
        try {
          managed.revoke();
        } catch {
          /* already revoked */
        }
      }
      urls.current = [];
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({
      status: assetId ? ASSET_READ_STATE.LOADING : ASSET_READ_STATE.MISSING,
      code: null,
      policy: null,
      meta: null,
    });
    if (!assetId) return undefined;

    readFileAttachmentAsset(assetId, acceptedAssetKinds, {
      // Reported the moment a download genuinely starts, so a card waiting on
      // the workspace's copy says so instead of sitting on "Loading…".
      onState: (phase) => {
        if (cancelled) return;
        setState((prev) =>
          prev.status === ASSET_READ_STATE.READY ? prev : { ...prev, status: phase }
        );
      },
    }).then(({ state: status, code, asset }) => {
      if (cancelled) return;
      if (!asset) {
        setState({ status, code, policy: null, meta: null });
        return;
      }
      setState({
        status: ASSET_READ_STATE.READY,
        code: null,
        // Decided from the Blob's own type; the reference's type is a
        // consistency check only, exactly as for Template-form File evidence.
        policy: resolveOpenPolicy(asset.blob.type, mimeType),
        meta: {
          name: safeDownloadFilename(asset.name || name),
          mimeType: asset.blob.type || null,
          size: asset.blob.size,
        },
      });
    });

    return () => {
      cancelled = true;
    };
    // `acceptedAssetKinds` is stable for the life of a card (it comes from an
    // extension's own resolved `.configure()` options, set at editor-construction
    // time, or from a module constant), so it is listed but never actually
    // changes the effect's cadence.
  }, [assetId, mimeType, name, acceptedAssetKinds, attempt]);

  const displayName = state.meta?.name || fallbackName;
  const displayMime = state.meta ? state.meta.mimeType : mimeType;
  const displaySize = state.meta ? state.meta.size : size;
  const ready = state.status === ASSET_READ_STATE.READY;
  const loading = isBusyAssetRead(state.status);
  // "Recoverable" is not "available": the bytes may yet arrive, but they are
  // not here now, so the card must not offer to open or download them.
  const pendingRemote = isRecoverableAssetRead(state.status) && !ready;
  const missing = !ready && !pendingRemote;
  const stateMessage = ready
    ? null
    : assetReadMessage({
        state: state.status,
        code: state.code,
        surface: ASSET_READ_SURFACE.FILE,
      });
  const typeLabel = fileAttachmentLabel(displayMime, displayName);
  const metaText = fileAttachmentMetaText(displayMime, displayName, displaySize);
  const canOpen = ready && isInlineRenderable(state.policy);
  const openLabel = state.policy?.mode === RENDER_MODE.PDF ? "Open" : "Preview";

  function beginAction() {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    clearNotice();
    return true;
  }

  function endAction() {
    busyRef.current = false;
    setBusy(false);
  }

  function closePreview() {
    if (preview && preview.revoke) preview.revoke();
    setPreview(null);
  }

  // A PDF opens in a new tab, but the Blob is retrieved asynchronously — so the
  // tab is reserved HERE, synchronously, while the click's user activation is
  // still valid. Anything else is an in-app dialog and needs no tab.
  function handleOpenClick() {
    if (busyRef.current) return;
    const needsTab = state.policy?.mode === RENDER_MODE.PDF;
    const reservedTab = needsTab ? reserveNavigationTab() : null;
    if (needsTab && !reservedTab) {
      showNoticeError(ATTACHMENT_OPEN_FAILED_MESSAGE);
      return;
    }
    if (!beginAction()) return;
    handleOpen(reservedTab).finally(endAction);
  }

  async function handleOpen(reservedTab) {
    const result = await openAttachmentSafely({
      reservedTab,
      metadataMimeType: mimeType,
      getBlob: async () => {
        const asset = await loadFileAttachmentAsset(assetId, acceptedAssetKinds);
        return asset ? asset.blob : null;
      },
      createUrl: (blob, options) => trackUrl(createManagedObjectUrl(blob, options)),
    });

    if (result.policy) {
      setState((prev) => ({ ...prev, status: ASSET_READ_STATE.READY, policy: result.policy }));
    }

    switch (result.status) {
      case OPEN_RESULT.MISSING:
        setState({ status: ASSET_READ_STATE.MISSING, code: null, policy: null, meta: null });
        showNoticeError(ATTACHMENT_UNAVAILABLE_MESSAGE);
        return;
      case OPEN_RESULT.READ_ERROR:
      case OPEN_RESULT.BLOCKED:
        showNoticeError(ATTACHMENT_OPEN_FAILED_MESSAGE);
        return;
      case OPEN_RESULT.DENIED:
        // Denial never mutates or removes the attachment — it stays downloadable.
        showNoticeError(ATTACHMENT_PREVIEW_DENIED_MESSAGE);
        return;
      case OPEN_RESULT.TEXT_PREVIEW:
        // Read with blob.text() and rendered as escaped React text — no object
        // URL, no navigation.
        setPreview({ kind: "text", blob: result.blob });
        return;
      case OPEN_RESULT.IMAGE_PREVIEW:
        // Unreachable in practice: an image cannot be attached through this
        // path. Handled anyway so the shared policy gaining an image result can
        // never leave a created object URL alive with nothing shown.
        if (result.revoke) result.revoke();
        showNoticeError(ATTACHMENT_PREVIEW_DENIED_MESSAGE);
        return;
      default:
        // The PDF opened; its URL is tracked and auto-revoked. Nothing to show.
    }
  }

  async function handleDownload() {
    if (!beginAction()) return;
    try {
      const { state: status, code, asset } = await readFileAttachmentAsset(assetId, acceptedAssetKinds);
      if (!asset) {
        setState({ status, code, policy: null, meta: null });
        showNoticeError(ATTACHMENT_UNAVAILABLE_MESSAGE);
        return;
      }
      // `download` saves the file rather than rendering it, so this is safe for
      // every accepted type — including those refused inline above.
      const managed = trackUrl(
        createManagedObjectUrl(asset.blob, { revokeAfterMs: NAVIGATION_URL_REVOKE_MS })
      );
      const a = document.createElement("a");
      a.href = managed.url;
      a.download = safeDownloadFilename(asset.name || name);
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      showNoticeError(ATTACHMENT_DOWNLOAD_FAILED_MESSAGE);
    } finally {
      endAction();
    }
  }

  const ariaLabel = ready
    ? `Attached file ${displayName}. ${typeLabel}. ${metaText}.`
    : `Attached file ${displayName}. ${stateMessage || FILE_ATTACHMENT_UNAVAILABLE_TEXT}`;

  const content = (
    <>
      <div className={`${FILE_ATTACHMENT_CLASS}__body`}>
        <span className={`${FILE_ATTACHMENT_CLASS}__name`} title={displayName}>
          {displayName}
        </span>
        <span className={`${FILE_ATTACHMENT_CLASS}__meta`}>
          {loading ? stateMessage || FILE_ATTACHMENT_LOADING_TEXT : metaText}
        </span>
        {!ready && !loading && (
          <span
            className={`${FILE_ATTACHMENT_CLASS}__unavailable`}
            data-attachment-state={state.status}
          >
            {stateMessage || FILE_ATTACHMENT_UNAVAILABLE_TEXT}
            {isRetryableAssetRead(state.status) && (
              <button
                type="button"
                className={`${FILE_ATTACHMENT_CLASS}__btn`}
                onClick={() => setAttempt((n) => n + 1)}
                aria-label={`${RETRY_ASSET_READ_LABEL} loading ${displayName}`}
              >
                {RETRY_ASSET_READ_LABEL}
              </button>
            )}
          </span>
        )}
        {/* Print only: an exported or printed page cannot carry the binary, and
            must not imply that it does. */}
        <span className={`${FILE_ATTACHMENT_CLASS}__print-note`}>
          {PRINT_ATTACHMENT_NOTE}
        </span>
      </div>

      <div className={`${FILE_ATTACHMENT_CLASS}__actions`} contentEditable={false}>
        {canOpen && (
          <button
            type="button"
            className={`${FILE_ATTACHMENT_CLASS}__btn`}
            onClick={handleOpenClick}
            disabled={busy}
            title={`${openLabel} ${displayName}`}
            aria-label={`${openLabel} ${displayName}`}
          >
            {openLabel}
          </button>
        )}
        <button
          type="button"
          className={`${FILE_ATTACHMENT_CLASS}__btn`}
          onClick={handleDownload}
          disabled={busy || !ready}
          title={`Download ${displayName}`}
          aria-label={`Download ${displayName}`}
        >
          Download
        </button>
        {typeof onRemove === "function" && (
          <button
            type="button"
            className={`${FILE_ATTACHMENT_CLASS}__btn ${FILE_ATTACHMENT_CLASS}__btn--danger`}
            onClick={onRemove}
            title={`Remove attached file ${displayName}`}
            aria-label={`Remove attached file ${displayName}`}
          >
            Remove
          </button>
        )}
      </div>

      {/* One restrained live region per card. The message auto-dismisses after
          five seconds, a new attempt supersedes it, and its timer is cleared on
          unmount (see useTransientMessage). It never carries exception text. */}
      {!!notice.message && (
        <p className={`${FILE_ATTACHMENT_CLASS}__error`} role="alert">
          {notice.message}
        </p>
      )}

      {preview?.kind === "text" && (
        <TextPreviewDialog
          blob={preview.blob}
          name={displayName}
          onClose={closePreview}
        />
      )}
    </>
  );

  return {
    className: fileAttachmentWrapperClassNames({ missing, selected }),
    ariaLabel,
    displayName,
    missing,
    loading,
    /** Not here yet, but recoverable — never presented as a lost file. */
    pendingRemote,
    status: state.status,
    content,
  };
}

export default useFileAttachmentCard;
