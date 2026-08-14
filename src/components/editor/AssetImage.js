// src/components/editor/AssetImage.js
//
// The Free-form note's image node. It extends the installed TipTap Image
// extension rather than replacing it, adding exactly one capability: an image
// may be a REFERENCE to a Blob in IndexedDB (`assetId`) instead of carrying its
// own bytes.
//
// Three things it fixes or guarantees:
//
//  - Serialization. Every attribute renders through one pure function
//    (editorImageAttrsToHTML), so the stored note HTML can never contain a
//    `blob:` URL, and an asset-backed image can never contain a `src` at all.
//    That function is unit-tested; this file only wires it up.
//
//  - Parsing. The stock extension parses `img[src]:not([src^="data:"])`, which
//    silently DROPS a base64 image whenever the note HTML is re-parsed — on a
//    note switch or a reload. Existing notes contain such images from the
//    previous data-URL stopgap, so `allowBase64` is enabled and the parse rules
//    below also match an <img> that has a data-asset-id and no src at all.
//
//  - Rendering. A NodeView resolves the asset id to an object URL through the
//    shared hook that owns that URL's lifecycle (created on demand, revoked
//    when the asset id changes and on unmount, never persisted). A missing
//    asset renders readable text, never a broken-image icon.
import React from "react";
import Image from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import {
  EDITOR_IMAGE_ASSET_ATTR,
  EDITOR_IMAGE_LOADING_TEXT,
  EDITOR_IMAGE_UNAVAILABLE_TEXT,
  editorImageAttrsFromElement,
  editorImageAttrsToHTML,
  isPersistableImageSrc,
} from "../../lib/editorImageAssets";
import { MEDIA_LAYOUT_MODE } from "../../lib/editorMediaLayout";

function AssetImageView({ node }) {
  const { assetId, src, alt, title, width, height } = node.attrs;
  // The hook is called unconditionally (rules of hooks) and no-ops for a
  // non-asset image, which is what keeps remote and legacy images on the same
  // component without a second renderer.
  const { url, status } = useAssetObjectUrl(assetId || null);

  const label = alt || "Image";
  const dimensionProps = {};
  if (Number(width) > 0) dimensionProps.width = Math.round(Number(width));
  if (Number(height) > 0) dimensionProps.height = Math.round(Number(height));

  let body;
  if (assetId) {
    if (status === "loading") {
      body = (
        <span className="note-image-placeholder" role="status">
          {EDITOR_IMAGE_LOADING_TEXT}
        </span>
      );
    } else if (status === "ready" && url) {
      body = (
        <img src={url} alt={label} title={title || undefined} {...dimensionProps} />
      );
    } else {
      body = (
        <span className="note-image-placeholder note-image-placeholder--missing">
          {EDITOR_IMAGE_UNAVAILABLE_TEXT}
          {alt ? ` (${alt})` : ""}
        </span>
      );
    }
  } else if (isPersistableImageSrc(src)) {
    // A remote http/https image, or a legacy data:image kept for compatibility.
    body = <img src={src} alt={label} title={title || undefined} {...dimensionProps} />;
  } else {
    body = (
      <span className="note-image-placeholder note-image-placeholder--missing">
        {EDITOR_IMAGE_UNAVAILABLE_TEXT}
      </span>
    );
  }

  return (
    <NodeViewWrapper as="div" className="note-image-node" data-drag-handle>
      {body}
    </NodeViewWrapper>
  );
}

export const AssetImage = Image.extend({
  // Legacy notes hold data: images; refusing to parse them would delete them.
  addOptions() {
    return {
      ...this.parent?.(),
      allowBase64: true,
    };
  },

  addAttributes() {
    // Every attribute renders nothing on its own — the node's renderHTML below
    // emits the whole set through one pure function, so there is exactly one
    // place that decides what a persisted image may contain.
    const none = () => ({});
    return {
      src: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).src,
        renderHTML: none,
      },
      alt: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).alt,
        renderHTML: none,
      },
      title: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).title,
        renderHTML: none,
      },
      width: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).width,
        renderHTML: none,
      },
      height: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).height,
        renderHTML: none,
      },
      assetId: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).assetId,
        renderHTML: none,
      },
      // Shared media-core presentation attributes (editorMediaLayout.js).
      // Schema/serialization foundation only in this phase: the NodeView above
      // does not read them yet, and the defaults are never emitted, so an
      // existing document renders and round-trips exactly as before.
      widthPct: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).widthPct,
        renderHTML: none,
      },
      layoutMode: {
        default: MEDIA_LAYOUT_MODE.BLOCK,
        parseHTML: (el) => editorImageAttrsFromElement(el).layoutMode,
        renderHTML: none,
      },
      layoutSide: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).layoutSide,
        renderHTML: none,
      },
    };
  },

  parseHTML() {
    return [
      // An asset-backed image has NO src, so it needs its own rule.
      { tag: `img[${EDITOR_IMAGE_ASSET_ATTR}]` },
      { tag: "img[src]" },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Anything another extension contributed passes through, EXCEPT the two
    // attributes this node owns: whatever route a src or an asset id arrived
    // by, the pure serializer below is the only thing allowed to emit them.
    const passthrough = { ...(HTMLAttributes || {}) };
    delete passthrough.src;
    delete passthrough[EDITOR_IMAGE_ASSET_ATTR];

    return [
      "img",
      mergeAttributes(
        this.options.HTMLAttributes,
        passthrough,
        editorImageAttrsToHTML(node.attrs)
      ),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AssetImageView);
  },
});

export default AssetImage;
