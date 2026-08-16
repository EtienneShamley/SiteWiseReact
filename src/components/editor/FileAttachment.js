// src/components/editor/FileAttachment.js
//
// THE SHARED FILE-ATTACHMENT NODE: a selectable atom block that renders as a
// compact document card (filename, readable type, size, a safe Open/Download
// action and Remove). Used by the Free-form editor and by the flexible Template
// Section editor alike, configured only by which asset KIND(S) it may open.
//
// The card itself — the asset load, the display metadata, the safe open policy,
// the notice, the markup — lives in ./fileAttachmentPresentation.js and is
// SHARED with the static Section document view, so an inactive Section's files
// and an active Section's files are the same card and activation cannot resize
// or restyle them. Everything ProseMirror-specific stays here.
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
import React, { useCallback } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import {
  DEFAULT_FILE_ATTACHMENT_ASSET_KINDS,
  FILE_ATTACHMENT_ASSET_ATTR,
  FILE_ATTACHMENT_CLASS,
  FILE_ATTACHMENT_NAME_ATTR,
  FILE_ATTACHMENT_NODE_NAME,
  FILE_ATTACHMENT_SIZE_ATTR,
  FILE_ATTACHMENT_TYPE_ATTR,
  FILE_ATTACHMENT_UNAVAILABLE_TEXT,
  fileAttachmentAttrsFromElement,
  fileAttachmentAttrsToHTML,
  fileAttachmentMetaText,
} from "../../lib/editorFileAttachments";
import { useFileAttachmentCard } from "./fileAttachmentPresentation";

function FileAttachmentView({ node, selected, deleteNode, editor, extension }) {
  const { assetId, name, mimeType, size } = node.attrs;
  // The kinds THIS instance of the node was configured to open — Free-form's
  // default when nothing was configured, a Template Section's own kind(s)
  // when it was. Read from the extension's resolved options, never assumed.
  const acceptedAssetKinds =
    (extension && extension.options && extension.options.acceptedAssetKinds) ||
    DEFAULT_FILE_ATTACHMENT_ASSET_KINDS;

  // Removing the node is an ordinary editor transaction: it persists through
  // the normal autosave path and Undo restores the reference. The stored Blob
  // is deliberately NOT deleted here — see docs/ARCHITECTURE.md.
  const editable = editor ? editor.isEditable : true;
  const handleRemove = useCallback(() => {
    if (typeof deleteNode === "function") deleteNode();
  }, [deleteNode]);

  // Everything a card IS — the asset load, the display metadata, the safe
  // open/download policy, the notice and the markup — comes from the shared
  // presentation, so the static Section document view renders an identical
  // card (see fileAttachmentPresentation.js). Only the two things that are
  // genuinely ProseMirror's are added here: the NodeViewWrapper and Remove.
  const { className, ariaLabel, content } = useFileAttachmentCard({
    assetId,
    name,
    mimeType,
    size,
    acceptedAssetKinds,
    selected,
    onRemove: editable ? handleRemove : null,
  });

  return (
    <NodeViewWrapper as="div" className={className} role="group" aria-label={ariaLabel}>
      {content}
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
