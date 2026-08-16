// src/components/editor/FileAttachment.js
//
// The Free-form note's file-attachment node: a selectable atom block that
// renders as a compact document card (filename, readable type, size, a safe
// Open/Download action and Remove).
//
// The document holds a REFERENCE and nothing else. Every attribute is
// serialized through one pure function (fileAttachmentAttrsToHTML), so stored
// note HTML can never contain a Blob, base64 bytes, a `blob:` URL, an object
// URL, availability, busy or error state. All runtime state lives in React
// state here — which is what guarantees that opening, downloading or merely
// selecting a card creates no editor transaction and therefore no autosave.
//
// SECURITY: the node's metadata is DISPLAY data, never authority.
//   - the asset record retrieved from IndexedDB decides everything;
//   - its `kind` must be one this INSTANCE of the node was configured to open
//     (`acceptedAssetKinds`, default `editor-file` — see
//     src/lib/editorFileAttachments.js). A Photo asset, a logo, or a file
//     belonging to a surface this instance was not configured for is refused
//     even if the note points at it. Kind policy and id/attribute SHAPE
//     validation are deliberately separate concerns — this option only ever
//     widens which SURFACE'S bytes a card may open, never how an id is
//     shaped or trusted;
//   - whether the file may be rendered inline is decided ONLY by the MIME type
//     of the Blob actually retrieved, through the shared allowlist policy in
//     src/lib/safeAttachmentOpen.js. The filename, the extension, the displayed
//     label and the node's own `data-file-type` carry no permission at all.
//   - the policy is evaluated twice: once after the asset loads (so the card
//     shows the right action) and again against the freshly retrieved Blob at
//     click time, which is the authoritative check.
//   - no URL is ever taken from stored note HTML and navigated to.
//
// Once the asset resolves, its AUTHORITATIVE metadata (kind-checked name, Blob
// type and Blob size) replaces the serialized display metadata on the card. The
// serialized values are used only to label the unavailable state when the asset
// cannot be retrieved at all.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { getAsset } from "../../lib/assetStorage";
import useTransientMessage from "../../hooks/useTransientMessage";
import {
  DEFAULT_FILE_ATTACHMENT_ASSET_KINDS,
  FILE_ATTACHMENT_ASSET_ATTR,
  FILE_ATTACHMENT_CLASS,
  FILE_ATTACHMENT_LOADING_TEXT,
  FILE_ATTACHMENT_NAME_ATTR,
  FILE_ATTACHMENT_NODE_NAME,
  FILE_ATTACHMENT_SIZE_ATTR,
  FILE_ATTACHMENT_TYPE_ATTR,
  FILE_ATTACHMENT_UNAVAILABLE_TEXT,
  PRINT_ATTACHMENT_NOTE,
  fileAttachmentAttrsFromElement,
  fileAttachmentAttrsToHTML,
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

const STATUS = { LOADING: "loading", READY: "ready", MISSING: "missing" };

/**
 * Retrieve the asset and confirm it is genuinely a file attachment THIS CARD
 * is configured to open. Returns null for a missing asset, an unreadable one,
 * or one of a kind this card was not configured to accept — all three present
 * identically to the user, because in every case this note cannot open this
 * file.
 *
 * `acceptedKinds` defaults to the Free-form default (see
 * DEFAULT_FILE_ATTACHMENT_ASSET_KINDS), so a card with no explicit
 * `.configure()` behaves exactly as it always has.
 */
async function loadAttachmentAsset(assetId, acceptedKinds) {
  if (!assetId) return null;
  let asset;
  try {
    asset = await getAsset(assetId);
  } catch {
    return null;
  }
  if (!asset || !asset.blob) return null;
  if (!isAcceptedFileAssetKind(asset.kind, acceptedKinds)) return null;
  return asset;
}

function FileAttachmentView({ node, selected, deleteNode, editor, extension }) {
  const { assetId, name, mimeType, size } = node.attrs;
  // The kinds THIS instance of the node was configured to open — Free-form's
  // default when nothing was configured, a Template Section's own kind(s)
  // when it was. Read from the extension's resolved options, never assumed.
  const acceptedAssetKinds =
    (extension && extension.options && extension.options.acceptedAssetKinds) ||
    DEFAULT_FILE_ATTACHMENT_ASSET_KINDS;

  // Serialized display metadata — used to draw the card before the asset
  // arrives, and to label the unavailable state if it never does.
  const fallbackName = safeDownloadFilename(name);

  // { status, policy, meta } where meta is the AUTHORITATIVE metadata read back
  // from the asset record once it resolves.
  const [state, setState] = useState({
    status: assetId ? STATUS.LOADING : STATUS.MISSING,
    policy: null,
    meta: null,
  });
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
      status: assetId ? STATUS.LOADING : STATUS.MISSING,
      policy: null,
      meta: null,
    });
    if (!assetId) return undefined;

    loadAttachmentAsset(assetId, acceptedAssetKinds).then((asset) => {
      if (cancelled) return;
      if (!asset) {
        setState({ status: STATUS.MISSING, policy: null, meta: null });
        return;
      }
      setState({
        status: STATUS.READY,
        // Decided from the Blob's own type; the node's type is a consistency
        // check only, exactly as for Template-form File evidence.
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
    // `acceptedAssetKinds` is stable for the life of this node instance (it
    // comes from the extension's own resolved `.configure()` options, set at
    // editor-construction time, never per-render), so it is listed but never
    // actually changes the effect's cadence.
  }, [assetId, mimeType, name, acceptedAssetKinds]);

  const displayName = state.meta?.name || fallbackName;
  const displayMime = state.meta ? state.meta.mimeType : mimeType;
  const displaySize = state.meta ? state.meta.size : size;
  const missing = state.status === STATUS.MISSING;
  const loading = state.status === STATUS.LOADING;
  const typeLabel = fileAttachmentLabel(displayMime, displayName);
  const metaText = fileAttachmentMetaText(displayMime, displayName, displaySize);
  const canOpen = !missing && !loading && isInlineRenderable(state.policy);
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
        const asset = await loadAttachmentAsset(assetId, acceptedAssetKinds);
        return asset ? asset.blob : null;
      },
      createUrl: (blob, options) => trackUrl(createManagedObjectUrl(blob, options)),
    });

    if (result.policy) {
      setState((prev) => ({ ...prev, status: STATUS.READY, policy: result.policy }));
    }

    switch (result.status) {
      case OPEN_RESULT.MISSING:
        setState({ status: STATUS.MISSING, policy: null, meta: null });
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
        return;
    }
  }

  async function handleDownload() {
    if (!beginAction()) return;
    try {
      const asset = await loadAttachmentAsset(assetId, acceptedAssetKinds);
      if (!asset) {
        setState({ status: STATUS.MISSING, policy: null, meta: null });
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

  // Removing the node is an ordinary editor transaction: it persists through
  // the normal autosave path and Undo restores the reference. The stored Blob
  // is deliberately NOT deleted here — see docs/ARCHITECTURE.md.
  function handleRemove() {
    if (typeof deleteNode === "function") deleteNode();
  }

  const editable = editor ? editor.isEditable : true;

  const accessibleLabel = missing
    ? `Attached file ${displayName}. ${FILE_ATTACHMENT_UNAVAILABLE_TEXT}`
    : `Attached file ${displayName}. ${typeLabel}. ${metaText}.`;

  return (
    <NodeViewWrapper
      as="div"
      className={[
        FILE_ATTACHMENT_CLASS,
        missing ? `${FILE_ATTACHMENT_CLASS}--missing` : "",
        selected ? `${FILE_ATTACHMENT_CLASS}--selected` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={accessibleLabel}
    >
      <div className={`${FILE_ATTACHMENT_CLASS}__body`}>
        <span className={`${FILE_ATTACHMENT_CLASS}__name`} title={displayName}>
          {displayName}
        </span>
        <span className={`${FILE_ATTACHMENT_CLASS}__meta`}>
          {loading ? FILE_ATTACHMENT_LOADING_TEXT : metaText}
        </span>
        {missing && (
          <span className={`${FILE_ATTACHMENT_CLASS}__unavailable`}>
            {FILE_ATTACHMENT_UNAVAILABLE_TEXT}
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
          disabled={busy || missing || loading}
          title={`Download ${displayName}`}
          aria-label={`Download ${displayName}`}
        >
          Download
        </button>
        {editable && (
          <button
            type="button"
            className={`${FILE_ATTACHMENT_CLASS}__btn ${FILE_ATTACHMENT_CLASS}__btn--danger`}
            onClick={handleRemove}
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
    </NodeViewWrapper>
  );
}

export const FileAttachment = Node.create({
  name: FILE_ATTACHMENT_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,
  // Deliberately not draggable: a card carrying its own buttons has no
  // unambiguous drag surface, and dragging is not part of this feature.
  draggable: false,

  // `acceptedAssetKinds` is the ONE thing a consuming surface configures.
  // Free-form never calls `.configure()`, so it gets exactly today's
  // behaviour; a future Template Section editor configures its own kind(s)
  // (see src/components/editor/sectionEditorExtensions.js). Everything else
  // about the node — its schema, its parser, its serializer, its NodeView —
  // is shared and unconfigured.
  addOptions() {
    return {
      ...this.parent?.(),
      acceptedAssetKinds: DEFAULT_FILE_ATTACHMENT_ASSET_KINDS,
    };
  },

  addAttributes() {
    // Every attribute renders nothing on its own — renderHTML below emits the
    // whole set through one pure function, so there is exactly one place that
    // decides what a persisted attachment may contain.
    const none = () => ({});
    return {
      assetId: {
        default: null,
        parseHTML: (el) => fileAttachmentAttrsFromElement(el).assetId,
        renderHTML: none,
      },
      name: {
        default: null,
        parseHTML: (el) => fileAttachmentAttrsFromElement(el).name,
        renderHTML: none,
      },
      mimeType: {
        default: null,
        parseHTML: (el) => fileAttachmentAttrsFromElement(el).mimeType,
        renderHTML: none,
      },
      size: {
        default: 0,
        parseHTML: (el) => fileAttachmentAttrsFromElement(el).size,
        renderHTML: none,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[${FILE_ATTACHMENT_ASSET_ATTR}]`,
        // A reference that fails validation is refused as a node. The div's
        // readable text is then parsed as ordinary content instead, so nothing
        // in the user's note is destroyed by a malformed attribute.
        getAttrs: (element) =>
          fileAttachmentAttrsFromElement(element).assetId ? null : false,
      },
    ];
  },

  renderHTML({ node }) {
    const attrs = fileAttachmentAttrsToHTML(node.attrs);
    if (!attrs) {
      // No usable reference: emit readable text rather than an attachment-shaped
      // element that can never resolve.
      return ["p", {}, FILE_ATTACHMENT_UNAVAILABLE_TEXT];
    }
    const name = attrs[FILE_ATTACHMENT_NAME_ATTR];
    const meta = fileAttachmentMetaText(
      attrs[FILE_ATTACHMENT_TYPE_ATTR],
      name,
      attrs[FILE_ATTACHMENT_SIZE_ATTR]
    );
    // The visible text is part of the serialized form, so any consumer that
    // does not understand the node still shows a readable reference rather than
    // an empty box. Values are emitted as DOM text/attributes and are escaped
    // by the serializer — no HTML string is ever assembled from a filename.
    return [
      "div",
      mergeAttributes(attrs),
      ["span", { class: `${FILE_ATTACHMENT_CLASS}__name` }, name],
      ["span", { class: `${FILE_ATTACHMENT_CLASS}__meta` }, meta],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentView);
  },
});

export default FileAttachment;
